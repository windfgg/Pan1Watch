from fastapi import HTTPException
import pytest

from src.web.api.accounts import (
    normalize_account_market,
    parse_account_markets,
    validate_position_quantity_for_market,
    validate_market_currency_pair,
    validate_markets_currency_pair,
)


def test_normalize_account_market_supports_fund() -> None:
    assert normalize_account_market("fund") == "FUND"


def test_parse_account_markets_supports_multi_values() -> None:
    assert parse_account_markets("cn,hk,us") == ["CN", "HK", "US"]


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


def test_validate_markets_currency_pair_accepts_multi_market_with_any_supported_currency() -> None:
    validate_markets_currency_pair(["CN", "HK"], "CNY")
    validate_markets_currency_pair(["CN", "HK"], "HKD")
    validate_markets_currency_pair(["CN", "HK"], "USD")


def test_validate_markets_currency_pair_keeps_single_market_strict_rule() -> None:
    with pytest.raises(HTTPException):
        validate_markets_currency_pair(["HK"], "CNY")


@pytest.mark.parametrize(
    "market,quantity",
    [
        ("US", 0.5),
        ("US", 1.25),
        ("CN", 100),
        ("HK", 200),
    ],
)
def test_validate_position_quantity_for_market_accepts_valid_values(market: str, quantity: float) -> None:
    validate_position_quantity_for_market(quantity, market)


@pytest.mark.parametrize(
    "market,quantity",
    [
        ("CN", 100.5),
        ("HK", 20.75),
        ("US", 0.12345),
    ],
)
def test_validate_position_quantity_for_market_rejects_invalid_fractional_values(market: str, quantity: float) -> None:
    with pytest.raises(HTTPException):
        validate_position_quantity_for_market(quantity, market)
