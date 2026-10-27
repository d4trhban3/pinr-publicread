"""Offline checks for quote_price (pool price math and the depth floor). Run: python3 test_quote_price.py"""
import quote_price as Q

T, O = "0x" + "aa" * 20, "0x" + "bb" * 20
w = lambda n: "%064x" % n
ad = lambda a: "0x" + "0" * 24 + a[2:]
ok = 0


def check(name, cond):
    global ok
    ok += bool(cond)
    print(("PASS " if cond else "FAIL ") + name)


# v2: token0 = T, reserves 1,000 T and 2,000 O (18 decimals each) -> 2 O per T
r = Q._price_from("v2", [ad(T), ad(O), "0x" + w(2000 * 10**18), "0x" + w(1000 * 10**18) + w(2000 * 10**18) + w(0)], T, O, 18, 18)
check("v2 price, tok is token0", r and abs(r[0] - 2) < 1e-12 and abs(r[1] - 2000) < 1e-9)
# v2: token0 = O -> same pool seen from the other side
r = Q._price_from("v2", [ad(O), ad(T), "0x" + w(2000 * 10**18), "0x" + w(2000 * 10**18) + w(1000 * 10**18) + w(0)], T, O, 18, 18)
check("v2 price, tok is token1", r and abs(r[0] - 2) < 1e-12)
# v3: sqrtPriceX96 for price 4 (token1 per token0), tok = token0, different decimals (tok 6, other 18)
sp = 2 * 2**96
r = Q._price_from("v3/500", [ad(T), ad(O), "0x" + w(5 * 10**18), "0x" + w(sp) + w(0) * 6], T, O, 6, 18)
check("v3 price with decimals", r and abs(r[0] - 4 * 10**6 / 10**18) < 1e-18)
check("v3 inverted when tok is token1",
      abs(Q._price_from("v3/500", [ad(O), ad(T), "0x" + w(10**18), "0x" + w(sp) + w(0) * 6], T, O, 18, 18)[0] - 0.25) < 1e-12)
# a pool that does not hold exactly these two coins is refused
check("wrong pair refused", Q._price_from("v2", [ad(T), ad("0x" + "cc" * 20), "0x" + w(1), "0x" + w(1) + w(1) + w(0)], T, O, 18, 18) is None)
# empty pool / unreadable state -> None, never 0
check("empty reserves -> None", Q._price_from("v2", [ad(T), ad(O), "0x" + w(0), "0x" + w(0) + w(0) + w(0)], T, O, 18, 18) is None)
check("missing state -> None", Q._price_from("v3/500", [ad(T), ad(O), "0x" + w(1), None], T, O, 18, 18) is None)
check("depth floor is $50,000", Q.MIN_DEPTH_USD == 50_000.0)
print(f"{ok}/8 passed")
