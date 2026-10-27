"""EVM toolkit checked against public reference values (no network).
Run:  python3 test_evm.py"""
from evm import keccak256, selector, topic, enc_address, words, dec, dec_string

results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")

case(1, "Keccak-256 of empty input", "the published reference value c5d24601...a470",
     lambda: (keccak256(b"").hex() == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470", keccak256(b"").hex()))
case(2, "ERC-20 transfer(address,uint256) selector", "a9059cbb (the selector every wallet uses)",
     lambda: (selector("transfer(address,uint256)") == "a9059cbb", selector("transfer(address,uint256)")))
case(3, "ERC-20 Transfer event topic", "ddf252ad...b3ef (the well-known Transfer topic)",
     lambda: (topic("Transfer(address,address,uint256)") == "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", topic("Transfer(address,address,uint256)")))
case(4, "Long input (more than one hash block)", "keccak256 of 200 'a' bytes matches Alchemy's web3_sha3 reference",
     lambda: (keccak256(b"a" * 200).hex() == "96ea54061def936c4be90b518992fdc6f12f535068a256229aca54267b4d084d", keccak256(b"a" * 200).hex()))

def c5():
    data = "0x" + "0" * 63 + "1" + enc_address("0x00000000000000000000000000000000DeaDBeef") + "0" * 63 + "1"
    w = words(data)
    return ((dec(w[0], "uint256"), dec(w[1], "address"), dec(w[2], "bool")) == (1, "0x00000000000000000000000000000000deadbeef", True), "uint, address, bool decoded")
case(5, "Decoding a returned (uint, address, bool)", "1, the address, true", c5)

def c6():
    s = "hello"
    data = "0x" + "0" * 62 + "20" + "0" * 63 + "5" + s.encode().hex().ljust(64, "0")
    return (dec_string(data, words(data)[0]) == "hello", "string decoded")
case(6, "Decoding a returned string", "'hello'", c6)

def c7():
    from run_evm import borrowed_post
    own = borrowed_post("https://x.com/SomeDev/status/123", "somedev")
    other = borrowed_post("https://twitter.com/FamousAccount/status/456?s=20", "somedev")
    lookalike = borrowed_post("https://x.com/exampleo/status/789", "example0")
    none = borrowed_post(None, "somedev")
    return (own is None and other == "FamousAccount" and lookalike == "exampleo" and none is None,
            f"own post -> {own}; someone else's post -> {other}; look-alike handle -> {lookalike}; no post -> {none}")
case(7, "Borrowed post: the token links someone else's post",
     "flags the other account; the launcher's own post is fine; a look-alike handle (o vs 0) is a different account", c7)

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
