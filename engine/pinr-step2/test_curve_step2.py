"""Bonding-curve piece: plain-English synthetic test curves.
Run:  python3 test_curve_step2.py
Numbers are made up, except the public Pump.fun launch settings
(1,073,000,000 virtual tokens and 30 virtual SOL), which every standard curve starts from."""
import sys
from curve_math_v1 import *
sys.path.insert(0, "../pinr-index")

results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")

def refuses(fn, word):
    try: fn()
    except ValueError as e: return (word in str(e), f"refused with: {e}")
    return (False, "did NOT refuse")

rel = lambda a, b: abs(a - b) <= 1e-9 * max(abs(a), abs(b))
VT0, VS0 = 1_073_000_000_000_000, 30_000_000_000          # Pump launch settings (raw units)
K = VT0 * VS0

def pump(vs, rs, decimals_q=9, **kw):
    vt = K // vs
    return CurveState(CurveKind.PUMP_VIRTUAL_CPMM, 6, decimals_q, 1_000_000_000_000_000,
                      vt, vs, 0, rs, **kw)

def c1():
    s = pump(VS0, 0)
    price = spot_price_quote_per_token(s)
    real, val = curve_depth_inputs(s, 150.0)
    return (rel(price, 30 / 1_073_000_000) and real == 0 and rel(val, 30 / 1.073 * 150),
            f"price {price:.3e} SOL, real money ${real:,.0f}, valuation ${val:,.0f}")
case(1, "Brand-new Pump.fun curve, nobody has bought yet",
     "valued at about 28 SOL ($4,194) but real money is $0: the 30 SOL is virtual", c1)


def c3():
    # fresh USDC-quoted curve: same 1,073,000,000 virtual tokens, 4,292 virtual USDC
    s = CurveState(CurveKind.PUMP_VIRTUAL_CPMM, 6, 6, 1_000_000_000_000_000, VT0, 4_292_000_000, 0, 0)
    price = spot_price_quote_per_token(s)
    real, val = curve_depth_inputs(s, 1.0)
    return (rel(price, 4292 / 1_073_000_000) and real == 0 and abs(val - 4000) < 1e-6,
            f"price {price:.3e} USDC per token, valuation ${val:,.2f}, real money ${real:,.0f}")
case(3, "Brand-new Pump.fun curve paired with USDC (6 decimals) instead of SOL",
     "price scaled for USDC decimals: valued at $4,000, real money $0", c3)

def c4():
    vb, vq, rb = 1_000_000_000_000_000, 1_000_000_000, 100_000_000_000_000
    rq = vq * vb // (vb - rb) - vq                          # quote raised for 10% of base sold
    s = CurveState(CurveKind.LAUNCHLAB_CONSTANT_PRODUCT, 6, 9, 1_000_000_000_000_000, vb, vq, rb, rq)
    price = spot_price_quote_per_token(s)
    invariant = (vq + rq) * (vb - rb) / (vq * vb)
    return (rel(price, (vq + rq) / (vb - rb) / 1000) and abs(invariant - 1) < 1e-8 and rel(real_quote_deposited(s), rq / 1e9),
            f"price {price:.4e}, real money {real_quote_deposited(s):.4f} quote, curve constant held {invariant:.10f}")
case(4, "LaunchLab curve after 10% of the tokens sold",
     "price = (virtual + real quote) / (virtual base - base sold); the curve's constant holds", c4)

case(5, "Curve that already graduated", "refuses: price the new pool instead",
     lambda: refuses(lambda: spot_price_quote_per_token(pump(VS0, 0, complete=True)), "complete"))

case(6, "Pump.fun 'mayhem mode' curve", "refuses: its pricing rule isn't confirmed yet",
     lambda: refuses(lambda: spot_price_quote_per_token(pump(VS0, 0, mayhem_mode=True)), "mayhem"))

case(7, "LaunchLab linear curve", "refuses: not checked on chain yet",
     lambda: refuses(lambda: spot_price_quote_per_token(CurveState(CurveKind.LAUNCHLAB_LINEAR, 6, 9, 10**15, 10**15, 10**9, 0, 0)), "linear"))

def c8():
    real, val = curve_depth_inputs(pump(VS0 + 10**9, 10**9), None)
    return (real is None and val is None, f"real {real}, valuation {val}")
case(8, "Quote price (SOL in dollars) not available", "both numbers stay missing, never guessed", c8)


print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
