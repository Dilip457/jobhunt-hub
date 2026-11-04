"""What the publisher refuses to put on the site, and the fetcher refuses to read."""

import os
import re

from enrich_experience import is_public_url
from export import valid_url
from publish import drop_unsafe, finalize_job, redact_contacts, unsafe_listing

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def job(**overrides):
    base = {"title": "Business Analyst", "company": "Acme", "url": "https://www.naukri.com/job/1", "snippet": "SQL and UAT."}
    return {**base, **overrides}


def test_valid_url_accepts_only_plain_http_links():
    for good in ("https://www.naukri.com/job/1?a=b", "http://example.com/a", " https://example.com/ "):
        assert valid_url(good), good
    for bad in (
        "javascript:alert(1)",
        "JAVASCRIPT:alert(1)",
        "data:text/html,x",
        "file:///etc/passwd",
        "//example.com/a",
        "https://",
        "https://www.naukri.com@evil.example/",
        "https://user:pw@example.com/",
        "https://exa mple.com/",
        "https://example.com/\nSet-Cookie: x",
        "",
        None,
        42,
    ):
        assert not valid_url(bad), bad


def test_unsafe_listing_rejects_bad_links_and_fee_demands():
    assert unsafe_listing(job()) is None
    assert unsafe_listing(job(url="javascript:alert(1)")) == "unsafe link"
    assert unsafe_listing(job(url="https://bit.ly/abc")) == "shortener or chat link"
    assert unsafe_listing(job(apply_url="https://wa.me/919999999999")) == "shortener or chat link"
    assert unsafe_listing(job(url="https://www.t.me/x")) == "shortener or chat link"
    for text in ("Pay the registration fee to join", "Refundable deposit of Rs 500", "Training fees apply", "Interview charges"):
        assert unsafe_listing(job(snippet=text)) == "asks for a fee", text


def test_unsafe_listing_leaves_ordinary_wording_alone():
    for text in (
        "Competitive pay and benefits",
        "Payment systems experience",
        "Build the fee calculation service",
        "Product Designer - WhatsApp India",
        "Processing large datasets for security teams",
    ):
        assert unsafe_listing(job(snippet=text)) is None, text


def test_drop_unsafe_recounts():
    payload = {"jobs": [job(), job(url="data:text/html,x")], "count": 2}
    assert drop_unsafe(payload, "ba") == 1
    assert payload["count"] == 1 and len(payload["jobs"]) == 1


def test_contacts_are_removed_from_snippets():
    assert redact_contacts("Mail hr.team@acme.co.in or call +91 98765 43210.") == "Mail [contact removed] or call [contact removed]."
    assert redact_contacts("Call 9876543210 today") == "Call [contact removed] today"
    # Years, salaries and ids are not phone numbers.
    for text in ("3-8 years, 1200000 INR", "Job id 123456789012", "Team of 5000"):
        assert redact_contacts(text) == text
    finalized = finalize_job(job(snippet="Write to a.b@acme.com"))
    assert finalized["snippet"] == "Write to [contact removed]"


def test_finalize_drops_an_unsafe_apply_link():
    assert "apply_url" not in finalize_job(job(apply_url="javascript:alert(1)"))
    assert finalize_job(job(apply_url="https://acme.example/apply"))["apply_url"] == "https://acme.example/apply"


def test_is_public_url_refuses_local_addresses():
    assert is_public_url("https://www.naukri.com/job/1")
    assert is_public_url("http://8.8.8.8/")
    for url in (
        "http://169.254.169.254/latest/meta-data/",
        "http://127.0.0.1:8080/",
        "http://10.0.0.1/",
        "http://192.168.1.1/",
        "http://[::1]/",
        "http://localhost/",
        "http://metadata.internal/",
        "file:///etc/passwd",
        "ftp://example.com/",
        "",
    ):
        assert not is_public_url(url), url


def test_every_action_is_pinned_to_a_commit():
    workflows = os.path.join(ROOT, ".github", "workflows")
    for name in os.listdir(workflows):
        with open(os.path.join(workflows, name), encoding="utf-8") as handle:
            for ref in re.findall(r"^\s*(?:- )?uses:\s*(\S+)", handle.read(), re.M):
                assert re.fullmatch(r"[\w.-]+/[\w./-]+@[0-9a-f]{40}", ref), f"{name}: {ref}"


def test_secret_shaped_files_are_ignored():
    with open(os.path.join(ROOT, ".gitignore"), encoding="utf-8") as handle:
        rules = handle.read().splitlines()
    for rule in (".env*", "!.env.example", "*.pem", "*.key"):
        assert rule in rules, rule
