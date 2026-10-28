import datetime as dt
import hashlib
import json
import sys
from pathlib import Path

if len(sys.argv) != 2:
    raise SystemExit('Usage: python scripts/generate-humanized-fixtures.py <Control Center 0.2.74 directory>')
reference = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(reference))
from polycards_tester.behavior_profiles import HumanizedAssignment, _compute_assignments, REGIONS, local_datetime
from polycards_tester.behavior_engine import daily_plan, plan_next_action

class Rng:
    def __init__(self, values):
        self.values = iter(values * 20)
    def random(self):
        return next(self.values)
    def uniform(self, lo, hi):
        return lo + self.random() * (hi - lo)
    def randint(self, lo, hi):
        return lo + int(self.random() * (hi - lo + 1))

cases = []
for persona in ['heavy', 'active', 'normal', 'casual', 'rare']:
    for region in REGIONS:
        pid = f'parity-{persona}-{region}'
        shift = -75 + int.from_bytes(hashlib.sha256(f'schedule-shift-v1:{pid}'.encode()).digest()[:8], 'big') % 151
        assignment = HumanizedAssignment(persona, region, shift)
        for date_text in ['2026-10-18', '2026-10-19', '2026-01-01', '2026-07-01']:
            date = dt.date.fromisoformat(date_text)
            plan = daily_plan(assignment, pid, date)
            probes = [dt.datetime.combine(date, dt.time(0, 0), dt.timezone.utc)]
            for session in plan.sessions:
                # Use timezone-aware region conversion, including DST, without executing engine/GUI.
                zone = local_datetime(assignment.region, dt.datetime.combine(date, dt.time(12), dt.timezone.utc)).tzinfo
                local = dt.datetime.combine(date, dt.time(), zone) + dt.timedelta(minutes=session.start_minute+2)
                probes.append(local.astimezone(dt.timezone.utc))
                break
            for now in probes:
                base = dict(profileId=pid, persona=persona, region=region, label='Reference', scheduleShiftMinutes=shift, sessionKey=None, sessionDraws=0, nextDrawAt=None)
                values = [0.5]
                decision = plan_next_action(assignment, pid, now_utc=now, rng=Rng(values))
                def add(state, dec, values, after=False, spend=0, value=0):
                    cases.append(dict(state=state, now=int(now.timestamp()*1000), random=values, afterCycle=after, spend=spend, value=value,
                        expected=dict(delayMs=max(15, dec.delay_seconds)*1000, reason=dec.reason, behaviorState=dec.state, dayType=dec.day_type)))
                add(base, decision, values)
                if decision.timer_kind == 'DRAW':
                    for x in [0.01, 0.15, 0.3, 0.5, 0.9]:
                        state = dict(base, sessionKey=decision.session_key, sessionDraws=1, burstRemaining=0, fatigue=0.2)
                        values = [x, 0.5, 0.5, 0.5]
                        dec = plan_next_action(assignment, pid, now_utc=now, rng=Rng(values), after_cycle=True, current_session_key=decision.session_key,
                            session_draws=2, fatigue=0.2, last_spend=4500, last_value=10000)
                        add(state, dec, values, True, 4500, 10000)
                    state = dict(base, sessionKey=decision.session_key, sessionDraws=2, burstRemaining=2, fatigue=0.4)
                    dec = plan_next_action(assignment, pid, now_utc=now, rng=Rng([0.5]), after_cycle=True, current_session_key=decision.session_key,session_draws=3,burst_remaining=2,fatigue=0.4)
                    add(state, dec, [0.5], True)

ids = [f'profile-{i}' for i in range(80)]
assignments = {pid:dict(persona=a.persona_key,region=a.region_key,scheduleShiftMinutes=a.schedule_shift_minutes) for pid,a in _compute_assignments(ids,'mixed',{},force_reassign=False).items()}
out = Path(__file__).resolve().parents[1] / 'backend/packages/api/src/api/utils/__tests__/fixtures/humanized-desktop-v0274.json'
out.parent.mkdir(exist_ok=True)
out.write_text(json.dumps(dict(source='PolyCards_Control_Center_v0.2.74: behavior_engine.py / behavior_profiles.py (pure functions only)', sourceSha256={f:hashlib.sha256((reference/'polycards_tester'/f).read_bytes()).hexdigest() for f in ['behavior_engine.py','behavior_profiles.py']}, assignments=assignments, cases=cases),indent=2)+'\n')
print(f'{len(cases)} reference cases generated; no engine, network or profile writes.')
