"""BNB linked-wallet specifics (no network). Run: python3 test_evm_linked.py"""
from evm_linked import is_route
results = []
def case(n, title, should, ok, text):
    results.append(ok); print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")
case(1, "Address with no code (ordinary wallet)", "not a route: can be linked", is_route("0x") is False, f"is_route('0x') = {is_route('0x')}")
case(2, "Trading-bot router contract", "a route: never linked; tokens sent to it are a sell", is_route("0x6080604052" + "00" * 100) is True, "contract code -> route")
case(3, "EIP-7702 smart personal wallet", "a personal wallet: can be linked", is_route("0xef0100" + "ab" * 20) is False, "delegation marker -> personal wallet")
case(4, "Code couldn't be read", "unknown (the group is marked incomplete), never guessed", is_route(None) is None, "None -> None")
print(f"\n{sum(results)}/{len(results)} passed"); raise SystemExit(0 if all(results) else 1)
