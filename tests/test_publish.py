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


def test_finalize_clears_guessed_experience_on_old_data():
    guessed = publish.finalize_job(job("a", title="Associate - BA", snippet="", experience_min=0, experience_max=2))
    stated = publish.finalize_job(job("b", title="Associate - BA", snippet="needs 7+ years", experience_min=7,
                                      experience_max=None))
    tagged = publish.finalize_job(job("c", title="Associate - BA", snippet="", experience_min=5, experience_max=9,
                                      experience_source="board"))
    assert (guessed["experience_min"], guessed["experience_max"]) == (None, None)
    assert stated["experience_min"] == 7
    assert (tagged["experience_min"], tagged["experience_max"]) == (5, 9)


def test_publish_drops_previously_published_offrole_titles(tmp_path):
    import json

    def ba(jobs):
        return {**payload(jobs), "role": "ba"}

    fresh = [job("a", title="Business Analyst")]
    old = [
        job("b", title="Product Analyst", last_seen=day(1)),
        job("c", title="Data Analyst", last_seen=day(1)),
        job("d", title="Functional Analyst", last_seen=day(1)),
    ]
    (tmp_path / "ba.json").write_text(json.dumps(ba(fresh)))
    previous = {"ba": json.dumps(ba(old))}
    payloads, _ = publish.build_payloads(str(tmp_path), previous, 21, 7, False)
    titles = sorted(j["title"] for j in payloads["ba"]["jobs"])
    assert titles == ["Business Analyst", "Data Analyst"]
    assert payloads["ba"]["count"] == 2


def test_generated_at_is_the_latest_time_in_utc():
    # 09:00 IST is 03:30 UTC: earlier than 05:00 UTC, though larger as a string.
    ist = payload([job("a")], generated="2026-10-31T09:00:00+05:30")
    utc = payload([job("b")], generated="2026-10-31T05:00:00+00:00")
    assert publish.merge_payloads(ist, utc, 21)["generated_at"] == "2026-10-31T05:00:00+00:00"
    assert publish.merge_payloads(utc, ist, 21)["generated_at"] == "2026-10-31T05:00:00+00:00"
    later_ist = payload([job("c")], generated="2026-10-31T11:00:00+05:30")
    assert publish.merge_payloads(utc, later_ist, 21)["generated_at"] == "2026-10-31T05:30:00+00:00"


def test_generated_at_falls_back_to_now_in_utc():
    out = publish.merge_payloads({}, {"role": "data", "jobs": [job("a")], "generated_at": "junk"}, 21)
    assert out["generated_at"].endswith("+00:00")
    assert publish.utc_now().endswith("+00:00")


def test_dropping_offrole_jobs_recounts_sources(tmp_path):
    import json

    def ba(jobs):
        return {**payload(jobs), "role": "ba"}

    fresh = [job("a", title="Business Analyst", source="Naukri")]
    old = [
        job("b", title="Product Analyst", source="Indeed", last_seen=day(1)),
        job("c", title="Business Analyst II", source="Indeed", last_seen=day(1)),
        job("d", title="Functional Analyst", source="Shine", last_seen=day(1)),
    ]
    (tmp_path / "ba.json").write_text(json.dumps(ba(fresh)))
    payloads, statuses = publish.build_payloads(str(tmp_path), {"ba": json.dumps(ba(old))}, 21, 7, False)
    out = payloads["ba"]
    assert out["count"] == len(out["jobs"]) == 2
    assert out["sources"] == {"Naukri": 1, "Indeed": 1}
    manifest = publish.build_manifest(payloads, statuses, publish.utc_now())
    assert sum(manifest["roles"]["ba"]["sources"].values()) == manifest["roles"]["ba"]["count"]


def test_kept_previous_ages_out_but_does_not_prune_unseen(tmp_path):
    import json

    previous = payload([
        job("expired", posted_date=day(30), last_seen=day(1), source="Indeed"),
        job("undated-old", posted_date=None, first_seen=day(25), last_seen=day(1), source="Indeed"),
        job("unseen", posted_date=day(5), last_seen=day(12), source="Shine"),
        job("recent", posted_date=day(2), last_seen=day(1)),
    ], generated="2026-10-20T08:00:00+05:30")
    previous["sources"] = {"Indeed": 2, "Shine": 1, "Naukri": 1}
    (tmp_path / "data.json").write_text(json.dumps(payload([])))
    payloads, statuses = publish.build_payloads(str(tmp_path), {"data": json.dumps(previous)}, 21, 7, False)
    out = payloads["data"]
    assert statuses["data"] == "kept-previous"
    # Retention applies (posted_date, else first_seen); the 12-day-unseen job stays.
    assert {j["url"] for j in out["jobs"]} == {"https://x.test/unseen", "https://x.test/recent"}
    assert out["count"] == 2
    assert out["sources"] == {"Shine": 1, "Naukri": 1}
    # The data is still as old as the last real scrape.
    assert out["generated_at"] == "2026-10-20T02:30:00+00:00"
    assert out["role"] == "data"


def test_finalize_keeps_or_computes_score_parts():
    given = publish.finalize_job(job("a", score_parts={"role": 50.0, "skill": 33.3}), role="data")
    assert given["score_parts"] == {"role": 50.0, "skill": 33.3}

    computed = publish.finalize_job(job("b", title="Data Engineer", snippet="spark and airflow pipelines"), role="data")
    assert computed["score_parts"]["role"] > 0 and computed["score_parts"]["skill"] > 0

    zeros = publish.finalize_job(job("c", score_parts={"role": 0.0, "skill": 0.0}, title="Analyst", snippet=""), role="data")
    assert "score_parts" not in zeros

    without_role = publish.finalize_job(job("d", score_parts={"role": 0}))
    assert "score_parts" not in without_role
