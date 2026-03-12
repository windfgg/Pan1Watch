import base64
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from src.web.api import mcp
from src.web.api.auth import create_token
from src.web.api.auth import AUTH_USERNAME_KEY, PASSWORD_HASH_KEY, hash_password
from src.web.database import get_db
from src.web.models import Account, AppSettings, Base, Stock


def _basic_auth_header(username: str, password: str) -> dict[str, str]:
    token = base64.b64encode(
        f"{username}:{password}".encode("utf-8")).decode("utf-8")
    return {"Authorization": f"Basic {token}"}


class TestMcpPositions(unittest.TestCase):
    def setUp(self):
        # 固定到 DB 配置认证，避免环境变量干扰用例。
        self._old_env_user = mcp.ENV_AUTH_USERNAME
        self._old_env_pass = mcp.ENV_AUTH_PASSWORD
        mcp.ENV_AUTH_USERNAME = None
        mcp.ENV_AUTH_PASSWORD = None

        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        TestingSessionLocal = sessionmaker(
            autocommit=False, autoflush=False, bind=engine)
        Base.metadata.create_all(bind=engine)

        db = TestingSessionLocal()
        db.add(AppSettings(key=AUTH_USERNAME_KEY,
               value="mcp_user", description=""))
        db.add(AppSettings(key=PASSWORD_HASH_KEY,
               value=hash_password("mcp_pass"), description=""))
        db.add(Account(name="main", available_funds=10000))
        db.add(Stock(symbol="600519", name="贵州茅台", market="CN"))
        db.commit()
        db.close()

        app = FastAPI()

        def override_get_db():
            db_local = TestingSessionLocal()
            try:
                yield db_local
            finally:
                db_local.close()

        app.dependency_overrides[get_db] = override_get_db
        app.include_router(mcp.router, prefix="/api/mcp")
        self.client = TestClient(app)

    def tearDown(self):
        mcp.ENV_AUTH_USERNAME = self._old_env_user
        mcp.ENV_AUTH_PASSWORD = self._old_env_pass

    def _rpc(self, method: str, params: dict | None = None, req_id: int = 1):
        return self.client.post(
            "/api/mcp",
            headers=_basic_auth_header("mcp_user", "mcp_pass"),
            json={
                "jsonrpc": "2.0",
                "id": req_id,
                "method": method,
                "params": params or {},
            },
        )

    def test_requires_basic_auth(self):
        resp = self.client.post(
            "/api/mcp",
            json={"jsonrpc": "2.0", "id": 1,
                  "method": "tools/list", "params": {}},
        )
        self.assertEqual(resp.status_code, 401)

    def test_tools_list_contains_dashboard_and_watchlist(self):
        resp = self._rpc("tools/list", req_id=11)
        self.assertEqual(resp.status_code, 200)
        tools = resp.json()["result"]["tools"]
        names = {item["name"] for item in tools}
        self.assertIn("dashboard.overview", names)
        self.assertIn("market.indices", names)
        self.assertIn("stocks.list", names)
        self.assertIn("stocks.quotes", names)
        self.assertIn("mcp.health", names)
        self.assertIn("mcp.auth.status", names)
        self.assertIn("mcp.version", names)

        by_name = {item["name"]: item for item in tools}
        self.assertIn("outputSchema", by_name["positions.list"])
        self.assertIn("examples", by_name["positions.list"])
        self.assertIn("tags", by_name["positions.list"])

    def test_watchlist_list_via_mcp(self):
        resp = self._rpc(
            "tools/call",
            {
                "name": "stocks.list",
                "arguments": {},
            },
            req_id=12,
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()["result"]["structuredContent"]
        self.assertEqual(data["count"], 1)
        self.assertEqual(data["items"][0]["symbol"], "600519")

    def test_auth_status_via_bearer(self):
        token, _ = create_token(expires_days=1)
        resp = self.client.post(
            "/api/mcp",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "jsonrpc": "2.0",
                "id": 31,
                "method": "tools/call",
                "params": {
                    "name": "mcp.auth.status",
                    "arguments": {},
                },
            },
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()["result"]["structuredContent"]
        self.assertEqual(data["auth"], "bearer")
        self.assertIn("user", data)

    def test_invalid_params_returns_standard_error_data(self):
        resp = self._rpc(
            "tools/call",
            {
                "name": "positions.list",
                "arguments": "not-an-object",
            },
            req_id=32,
        )
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertIn("error", body)
        self.assertEqual(body["error"]["code"], -32602)
        self.assertEqual(
            body["error"]["data"]["error_code"],
            "MCP_INVALID_PARAMS",
        )

    def test_position_crud_via_mcp(self):
        create_resp = self._rpc(
            "tools/call",
            {
                "name": "positions.create",
                "arguments": {
                    "account_id": 1,
                    "stock_id": 1,
                    "cost_price": 100.5,
                    "quantity": 10,
                },
            },
            req_id=2,
        )
        self.assertEqual(create_resp.status_code, 200)
        create_json = create_resp.json()
        create_data = create_json["result"]["structuredContent"]
        self.assertEqual(create_data["account_id"], 1)
        self.assertEqual(create_data["stock_id"], 1)
        position_id = create_data["id"]

        update_resp = self._rpc(
            "tools/call",
            {
                "name": "positions.update",
                "arguments": {
                    "position_id": position_id,
                    "quantity": 20,
                },
            },
            req_id=3,
        )
        self.assertEqual(update_resp.status_code, 200)
        update_data = update_resp.json()["result"]["structuredContent"]
        self.assertEqual(update_data["quantity"], 20)

        list_resp = self._rpc(
            "tools/call",
            {"name": "positions.list", "arguments": {"account_id": 1}},
            req_id=4,
        )
        self.assertEqual(list_resp.status_code, 200)
        list_data = list_resp.json()["result"]["structuredContent"]
        self.assertEqual(list_data["count"], 1)

        delete_resp = self._rpc(
            "tools/call",
            {"name": "positions.delete", "arguments": {"position_id": position_id}},
            req_id=5,
        )
        self.assertEqual(delete_resp.status_code, 200)
        delete_data = delete_resp.json()["result"]["structuredContent"]
        self.assertTrue(delete_data["success"])


if __name__ == "__main__":
    unittest.main()
