from api_sources import MAX_SKILL_HITS, MAX_TITLE_HITS, SCORE_BASE, SKILL_POINTS, TITLE_POINTS, _hit, score_job, title_relevant

KEYWORD_MAX = SCORE_BASE + TITLE_POINTS * MAX_TITLE_HITS + SKILL_POINTS * MAX_SKILL_HITS


def test_skill_tag_lists_cannot_saturate_the_score():
    # Foundit pastes its whole skill-tag list into the description.
    tags = "spark, pyspark, airflow, dbt, kafka, snowflake, databricks, etl, sql, python, aws, glue, redshift"
    score = score_job("data", "Senior Big Data Engineer", tags)
    assert score <= KEYWORD_MAX
    assert score < 70  # stays below a strong vendor resume match


def test_short_skills_need_word_boundaries():
    assert not _hit("ui", "build pipelines")
    assert not _hit("ux", "linux admin")
    assert _hit("ui", "ui designer")
    assert _hit("c#", "c# and .net")


def test_more_relevant_listing_scores_higher():
    strong = score_job("uiux", "Product Designer", "Figma, prototyping, user research, design system")
    weak = score_job("uiux", "Designer", "")
    assert strong > weak


def test_title_relevance_gate():
    assert title_relevant("data", "Data Engineer")
    assert not title_relevant("data", "Data Analyst")
    assert title_relevant("ba", "Business Analyst - Finance")


def test_ba_track_is_business_analyst_and_data_analyst_only():
    keep = [
        "Business Analyst", "Junior Business Analyst", "IT Business Analyst",
        "Senior Associate IS Business Systems Analyst", "Business Analyst - Risk",
        "Data Analyst", "Junior Data Analyst (SQL, Power BI)", "Business Data Analyst",
        "Associate, Business Analysis", "Data Analyst - Finance", "Business Analyst_3471",
        "Billable-PG_Business Analyst", "Lead Business System Analyst - Atlassian Products",
    ]
    drop = [
        "Product Analyst", "Functional Analyst", "Systems Analyst", "Process Analyst",
        "Requirements Analyst", "Business Process Analyst", "IT Analyst", "Analyst",
        "Financial Analyst", "QA Analyst", "Security Analyst", "Research Analyst",
        "HRIS Functional Analyst", "Product Owner", "Business Intelligence Developer",
        "Data Engineer", "Scrum Master", "Business Intelligence Analyst",
        "Business Analytics Analyst", "Business Functional Analyst",
    ]
    for title in keep:
        assert title_relevant("ba", title), title
    for title in drop:
        assert not title_relevant("ba", title), title
