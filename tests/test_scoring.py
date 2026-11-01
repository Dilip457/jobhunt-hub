from api_sources import MAX_SKILL_HITS, MAX_TITLE_HITS, ROLE_SKILLS, ROLE_TOOLS, SCORE_BASE, SKILL_POINTS, TITLE_POINTS, _hit, score_job, score_parts, title_relevant

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


def test_score_parts_follow_the_score_rules():
    sde = score_parts("sde", "Senior Software Engineer", "4-8 years. C#, .NET Core, Azure, REST APIs, SQL Server, Python.")
    assert set(sde) == {"role", "skill", "tool", "experience"}
    assert sde["experience"] == 100.0  # squarely in the 3-8 year band
    assert 0 < sde["role"] <= 100 and 0 < sde["skill"] <= 100 and 0 < sde["tool"] <= 100
    assert score_parts("sde", "Principal Engineer", "")["experience"] < 20

    ba = score_parts("ba", "Junior Business Analyst", "")
    assert ba["experience"] == 100.0
    assert score_parts("ba", "Senior Business Analyst", "")["experience"] == 0.0

    data = score_parts("data", "Senior Big Data Engineer", "spark, airflow, dbt, kafka, snowflake, databricks, etl")
    assert set(data) == {"role", "skill", "tool"}
    assert data["tool"] == 100.0  # six or more tools fill the allowance
    assert 0 < data["skill"] < 100  # "etl" is one of the practices

    assert score_parts("uiux", "Coordinator", "") == {"role": 0.0, "skill": 0.0, "tool": 0.0}


def test_tools_are_a_subset_of_the_scored_skills():
    # ROLE_TOOLS only splits the skill allowance for display; it must not add
    # tokens the score does not count.
    for role, tools in ROLE_TOOLS.items():
        assert set(tools) <= set(ROLE_SKILLS[role]), role
