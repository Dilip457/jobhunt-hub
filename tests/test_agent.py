from datetime import datetime, timedelta, timezone

import agent


def stamp(hours_ago: float, offset_hours: float = 0) -> str:
    tz = timezone(timedelta(hours=offset_hours))
    return (datetime.now(timezone.utc) - timedelta(hours=hours_ago)).astimezone(tz).isoformat(timespec="seconds")


def test_staleness_uses_the_oldest_role():
    manifest = {"roles": {
        "genai": {"generated_at": stamp(1)},
        "data": {"generated_at": stamp(30)},
        "ba": {"generated_at": stamp(2)},
    }}
    # One freshly refreshed role must not hide a role that is 30 hours old.
    assert 29.9 < agent.oldest_role_age_hours(manifest) < 30.1


def test_staleness_compares_offsets_as_times_not_strings():
    # 4 hours old written in IST sorts after 1 hour old in UTC as a string.
    ist_old = stamp(4, offset_hours=5.5)
    utc_new = stamp(1)
    assert ist_old > utc_new
    manifest = {"roles": {"genai": {"generated_at": ist_old}, "data": {"generated_at": utc_new}}}
    assert 3.9 < agent.oldest_role_age_hours(manifest) < 4.1


def test_staleness_unknown_without_timestamps():
    assert agent.oldest_role_age_hours({"roles": {"genai": {}, "data": {"generated_at": "junk"}}}) is None
    assert agent.oldest_role_age_hours({}) is None


def test_agent_writes_utc_and_reads_naive_as_utc():
    assert agent.iso_now().endswith("+00:00")
    naive = agent.parse_stamp("2026-10-31T05:00:00")
    assert naive == datetime(2026, 10, 31, 5, tzinfo=timezone.utc)
