from fastapi import HTTPException
import pytest

from src.web.api.accounts import (
    normalize_account_market,
    validate_market_currency_pair,
)


def test_normalize_account_market_supports_fund() -> None:
    assert normalize_account_market("fund") == "FUND"


@pytest.mark.parametrize(
    "market,currency",
    [
        ("CN", "CNY"),
        ("HK", "HKD"),
        ("US", "USD"),
        ("FUND", "CNY"),
    ],
)
def test_validate_market_currency_pair_accepts_expected_pairs(market: str, currency: str) -> None:
    validate_market_currency_pair(market, currency)


@pytest.mark.parametrize(
    "market,currency",
    [
        ("FUND", "USD"),
        ("FUND", "HKD"),
        ("HK", "CNY"),
    ],
)
def test_validate_market_currency_pair_rejects_invalid_pairs(market: str, currency: str) -> None:
    with pytest.raises(HTTPException):
        validate_market_currency_pair(market, currency)
