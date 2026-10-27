"""Uniswap v4 depth math: plain-English tests with made-up pools (no network). Run: python3 test_v4_depth.py"""
from decimal import Decimal
from v4_depth import rebuild, liquidity_at, amounts, sqrt_at_tick, Q96

results = []
def case(n, title, should, ok, text):
    results.append(ok); print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")

def sqrtx96(t):
    return int(sqrt_at_tick(t) * Q96)

r = rebuild([(-200, 1000), (200, -1000)])
case(1, "One position between ticks -200 and 200", "rebuilds one range with liquidity 1,000", r == [(-200, 200, 1000)], f"{r}")

r = rebuild([(-400, 500), (-200, 1000), (200, -1000), (400, -500)])
case(2, "Two overlapping positions", "middle range holds both (1,500); outer ranges 500 each",
     r == [(-400, -200, 500), (-200, 200, 1500), (200, 400, 500)] and liquidity_at(r, 0) == 1500, f"{r}; liquidity at tick 0 = {liquidity_at(r, 0)}")

a0, a1 = amounts([(1000, 2000, 10**18)], sqrtx96(0), 0)
case(3, "Position entirely above the current price", "holds only token0, no token1", a1 == 0 and a0 > 0, f"token0 {a0:.3e}, token1 {a1}")

a0, a1 = amounts([(-2000, -1000, 10**18)], sqrtx96(0), 0)
case(4, "Position entirely below the current price", "holds only token1, no token0", a0 == 0 and a1 > 0, f"token0 {a0}, token1 {a1:.3e}")

L = 10**18
a0, a1 = amounts([(-1000, 1000, L)], sqrtx96(0), 0)
exp1 = Decimal(L) * (Decimal(1) - sqrt_at_tick(-1000))
case(5, "Position straddling the price at tick 0", "token1 = L x (current - lower sqrt price), the textbook formula",
     abs(a1 - exp1) / exp1 < Decimal("1e-12"), f"token1 {a1:.6e} vs textbook {exp1:.6e}")

a0, a1 = amounts([(-1000, 1000, L)], sqrtx96(0), 0)
case(6, "Symmetric range around price 1 (tick 0)", "holds about the same value of each token", abs(a0 - a1) / a1 < Decimal("1e-9"), f"token0 {a0:.6e}, token1 {a1:.6e}")

print(f"\n{sum(results)}/{len(results)} passed"); raise SystemExit(0 if all(results) else 1)
