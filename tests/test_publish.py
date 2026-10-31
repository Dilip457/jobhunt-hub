from datetime import datetime, timedelta, timezone

import publish


def day(offset: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=offset)).date().isoformat()


def job(url, **extra):
    base = {"title": "Data Engineer", "company": f"Co {url}", "location": "Pune", "url": f"https://x.test/{url}",
            "source": "Naukri", "score": 50, "posted_date": day(1)}
    base.update(extra)
    return base


def payload(jobs, generated=None):
    return {"role": "data", "generated_at": generated or day(0) + "T00:00:00+00:00", "count": len(jobs), "jobs": jobs}


def test_fresh_copy_wins_and_first_seen_is_oldest():
    prev = payload([job("a", score=97, first_seen=day(5), last_seen=day(1))])
    fresh = payload([job("a", score=60, first_seen=day(0), last_seen=day(0))])
    out = publish.merge_payloads(prev, fresh, 21)
    assert out["count"] == 1
    merged = out["jobs"][0]
    assert merged["score"] == 60  # new scoring rules replace stale scores
    assert merged["first_seen"] == day(5)
    assert merged["last_seen"] == day(0)


def test_retention_and_unseen_pruning():
    prev = payload([
        job("old", posted_date=day(30), last_seen=day(1)),
        job("gone", last_seen=day(10)),
        job("recent", last_seen=day(2)),
    ])
    fresh = payload([job("new", last_seen=day(0))])
    keys = {j["url"] for j in publish.merge_payloads(prev, fresh, 21, unseen_days=7)["jobs"]}
    assert keys == {"https://x.test/recent", "https://x.test/new"}
    # Without unseen pruning, only the retention window applies.
    keys = {j["url"] for j in publish.merge_payloads(prev, fresh, 21)["jobs"]}
    assert "https://x.test/gone" in keys


def test_cross_board_duplicates_collapse():
    prev = payload([job("a", company="Acme", source="Shine", score=40)])
    fresh = payload([job("b", company="Acme Pvt Ltd", source="LinkedIn", score=70)])
    out = publish.merge_payloads(prev, fresh, 21)
    assert out["count"] == 1
    assert out["jobs"][0]["source"] == "LinkedIn"
    assert out["sources"] == {"LinkedIn": 1}


def test_finalize_recomputes_new_and_trims_fields():
    fresh = publish.finalize_job(job("a", first_seen=day(0), is_new=False, apply_url="https://x.test/a",
                                     score_parts={"role": 0}))
    old = publish.finalize_job(job("b", first_seen=day(9), is_new=True, apply_url="https://apply.test/b"))
    assert fresh["is_new"] is True and old["is_new"] is False
    assert "score_parts" not in fresh and "apply_url" not in fresh
    assert old["apply_url"] == "https://apply.test/b"


def test_build_payloads_keeps_previous_when_scrape_is_empty(tmp_path):
    import json

    (tmp_path / "data.json").write_text(json.dumps(payload([])))
    previous = {"data": json.dumps(payload([job("a", last_seen=day(20))]))}
    payloads, statuses = publish.build_payloads(str(tmp_path), previous, 21, 7, False)
    assert statuses["data"] == "kept-previous"
    assert payloads["data"]["count"] == 1


def test_small_fresh_run_does_not_prune(tmp_path):
    import json

    old_jobs = [job(f"p{i}", last_seen=day(10)) for i in range(10)]
    (tmp_path / "data.json").write_text(json.dumps(payload([job("n")])))
    (tmp_path / "data.json.status.json").write_text(json.dumps({"status": "partial"}))
    previous = {"data": json.dumps(payload(old_jobs))}
    payloads, statuses = publish.build_payloads(str(tmp_path), previous, 21, 7, False)
    assert statuses["data"] == "merged"
    assert payloads["data"]["count"] == 11


def test_role_artifacts_are_merged(tmp_path):
    import json

    (tmp_path / "data.json").write_text(json.dumps(payload([job("a")])))
    (tmp_path / "data.warp.json").write_text(json.dumps(payload([job("b", source="Indeed")])))
    payloads, statuses = publish.build_payloads(str(tmp_path), {}, 21, 7, False)
    assert statuses["data"] == "fresh"
    assert payloads["data"]["count"] == 2
    assert all(j["last_seen"] == day(0) for j in payloads["data"]["jobs"])
