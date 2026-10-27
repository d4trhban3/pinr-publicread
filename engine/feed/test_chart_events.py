"""Offline checks for chart events. Run: python3 test_chart_events.py"""
import json, os, shutil, tempfile
import chart_events as E

LABELS = ("VAMP", "BOT/RUG", "MAYHEM", "HONEYPOT")
ok = n = 0


def check(name, cond):
    global ok, n
    n += 1; ok += bool(cond)
    print(("PASS " if cond else "FAIL ") + name)


check("first state is not an event", E.changes(None, 40, None) == [])
check("score up", E.changes((40, None), 62, None) == [("score_up", 40, 62, None)])
check("score down", E.changes((62, None), 25, None) == [("score_down", 62, 25, None)])
check("same score: nothing", E.changes((40, None), 40, None) == [])
check("flag raised has no from/to", E.changes((40, None), None, "MAYHEM") == [("flag_raised", None, None, "MAYHEM")])
check("flag cleared has no from/to", E.changes((None, "HONEYPOT"), 30, None) == [("flag_cleared", None, None, "HONEYPOT")])
check("still flagged: nothing", E.changes((None, "VAMP"), None, "VAMP") == [])

tmp = tempfile.mkdtemp()
E.DB = os.path.join(tmp, "ev.sqlite")
rec = lambda s, lab, t: {"mint": "0xabc0000000000000000000000000000000000001", "score": s, "display": lab or str(s), "label": lab,
                         "as_of": t}
E.record(rec(40, None, "2026-10-06T10:00:00Z"), LABELS, tmp)
path = os.path.join(tmp, "events", "0xabc0000000000000000000000000000000000001.json")
check("no file for a token with no change", not os.path.exists(path))
E.record(rec(62, None, "2026-10-06T11:00:00Z"), LABELS, tmp)
E.record(rec(None, "MAYHEM", "2026-10-06T12:00:00Z"), LABELS, tmp)
added_old = E.record(rec(10, None, "2026-10-06T09:00:00Z"), LABELS, tmp)
doc = json.load(open(path))
ev = doc["events"]
check("file written after a change", doc["contract"] == "1.1" and len(ev) == 2)
check("score event carries from/to", ev[0] == {"t": 1791284400, "kind": "score_up", "from": 40, "to": 62, "text": "Score moved up"})
check("flag event: no from/to", ev[1] == {"t": 1791288000, "kind": "flag_raised", "text": "Label observed: MAYHEM"})
check("an older result never rewrites history", added_old == 0 and len(json.load(open(path))["events"]) == 2)
check("one flag changing to another is recorded", E.changes((None, "MAYHEM"), None, "BOT/RUG") == [("flag_raised", None, None, "BOT/RUG")])
E.record(rec(30, None, "2026-10-06T13:00:00Z"), LABELS, tmp)
check("cleared text names the flag", json.load(open(path))["events"][-1] == {"t": 1791291600, "kind": "flag_cleared", "text": "Label no longer observed: MAYHEM"})
check("texts are short and carry no reasons", all(len(t.format(label="BOT/RUG")) <= 60 for t in E.TEXT.values()))
shutil.rmtree(tmp)
print(f"{ok}/{n} passed")
