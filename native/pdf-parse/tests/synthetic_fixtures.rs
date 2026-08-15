use ctox_pdf_parse::{evaluate_page_fixture_text, PageFixture};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::fs;
use std::path::{Component, Path, PathBuf};

const MIN_FIXTURES: usize = 4;
const MAX_FIXTURES: usize = 6;
const MAX_SYNTHETIC_TEXT_BYTES: usize = 4_096;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SyntheticCorpus {
    name: String,
    description: Option<String>,
    fixtures: Vec<String>,
}

#[derive(Debug)]
struct SyntheticPageFixture {
    fixture: PageFixture,
    synthetic_text: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SyntheticPageFixtureWire {
    id: String,
    pdf: String,
    page: usize,
    description: Option<String>,
    #[serde(default)]
    expected_lines: Vec<String>,
    #[serde(default)]
    required_patterns: Vec<String>,
    #[serde(default)]
    ordered_phrases: Vec<String>,
    #[serde(default)]
    same_line_groups: Vec<Vec<String>>,
    #[serde(default)]
    separate_line_groups: Vec<Vec<String>>,
    #[serde(default)]
    forbidden_patterns: Vec<String>,
    #[serde(default)]
    allowed_missing_lines: usize,
    synthetic_text: String,
}

impl<'de> Deserialize<'de> for SyntheticPageFixture {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let wire = SyntheticPageFixtureWire::deserialize(deserializer)?;
        Ok(Self {
            fixture: PageFixture {
                id: wire.id,
                pdf: wire.pdf,
                page: wire.page,
                description: wire.description,
                expected_lines: wire.expected_lines,
                required_patterns: wire.required_patterns,
                ordered_phrases: wire.ordered_phrases,
                same_line_groups: wire.same_line_groups,
                separate_line_groups: wire.separate_line_groups,
                forbidden_patterns: wire.forbidden_patterns,
                allowed_missing_lines: wire.allowed_missing_lines,
            },
            synthetic_text: wire.synthetic_text,
        })
    }
}

#[derive(Default)]
struct EvaluationDimensions {
    exact_lines: bool,
    required_patterns: bool,
    ordered_phrases: bool,
    same_line_groups: bool,
    separate_line_groups: bool,
    forbidden_patterns: bool,
    allowed_missing_lines: bool,
}

#[test]
fn synthetic_page_contracts_are_complete_and_pass() {
    let fixtures_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let corpus: SyntheticCorpus = read_json(&fixtures_root.join("corpus.json"));

    assert_eq!(corpus.name, "workjet-synthetic-page-contracts");
    assert!(
        corpus
            .description
            .as_deref()
            .is_some_and(|description| description.contains("Workjet synthetic")),
        "synthetic corpus description must identify Workjet"
    );
    assert!(
        (MIN_FIXTURES..=MAX_FIXTURES).contains(&corpus.fixtures.len()),
        "synthetic corpus must contain {MIN_FIXTURES}..={MAX_FIXTURES} fixtures"
    );
    assert!(
        !fixtures_root.join("synthetic-pdfs").exists(),
        "placeholder PDF directory must not exist"
    );

    let manifest_paths: BTreeSet<_> = corpus.fixtures.iter().cloned().collect();
    assert_eq!(
        manifest_paths.len(),
        corpus.fixtures.len(),
        "synthetic corpus contains duplicate fixture paths"
    );

    let disk_paths = page_json_paths(&fixtures_root);
    assert_eq!(
        manifest_paths, disk_paths,
        "corpus must enumerate every direct pages/*.json file exactly once"
    );

    let mut fixture_ids = BTreeSet::new();
    let mut pdf_placeholders = BTreeSet::new();
    let mut dimensions = EvaluationDimensions::default();

    for relative_path in &corpus.fixtures {
        assert_direct_page_json_path(relative_path);
        let contract: SyntheticPageFixture = read_json(&fixtures_root.join(relative_path));
        let fixture = &contract.fixture;

        assert!(
            fixture_ids.insert(fixture.id.clone()),
            "duplicate synthetic fixture id `{}`",
            fixture.id
        );
        assert!(
            fixture.id.starts_with("workjet-") && fixture.id.len() <= 80,
            "synthetic fixture id must be bounded and Workjet-specific"
        );
        assert!(fixture.page > 0, "fixture `{}` has page zero", fixture.id);
        assert!(
            fixture
                .description
                .as_deref()
                .is_some_and(|description| description.contains("Workjet synthetic")),
            "fixture `{}` must have a Workjet synthetic description",
            fixture.id
        );
        assert_synthetic_pdf_placeholder(&fixture.pdf);
        assert!(
            pdf_placeholders.insert(fixture.pdf.clone()),
            "duplicate synthetic PDF placeholder in fixture `{}`",
            fixture.id
        );
        assert!(
            !fixtures_root.join(&fixture.pdf).exists(),
            "fixture `{}` points to a committed PDF",
            fixture.id
        );
        assert!(
            !contract.synthetic_text.trim().is_empty()
                && contract.synthetic_text.len() <= MAX_SYNTHETIC_TEXT_BYTES,
            "fixture `{}` synthetic text must be nonempty and at most {MAX_SYNTHETIC_TEXT_BYTES} bytes",
            fixture.id
        );
        assert!(
            contract.synthetic_text.contains("Workjet")
                && contract.synthetic_text.contains("Synthetic Reference 0001"),
            "fixture `{}` text must carry Workjet synthetic markers",
            fixture.id
        );

        dimensions.exact_lines |= !fixture.expected_lines.is_empty();
        dimensions.required_patterns |= !fixture.required_patterns.is_empty();
        dimensions.ordered_phrases |= !fixture.ordered_phrases.is_empty();
        dimensions.same_line_groups |= !fixture.same_line_groups.is_empty();
        dimensions.separate_line_groups |= !fixture.separate_line_groups.is_empty();
        dimensions.forbidden_patterns |= !fixture.forbidden_patterns.is_empty();
        dimensions.allowed_missing_lines |= fixture.allowed_missing_lines > 0;

        let evaluation = evaluate_page_fixture_text(fixture, &contract.synthetic_text);
        assert!(
            evaluation.passed,
            "fixture `{}` failed: lines={}/{}, required={}/{}, ordered={}/{}, same-line={}/{}, separate-line={}/{}, forbidden={}",
            fixture.id,
            evaluation.expected_line_hits,
            evaluation.expected_line_total,
            evaluation.required_pattern_hits,
            evaluation.required_pattern_total,
            evaluation.ordered_phrase_hits,
            evaluation.ordered_phrase_total,
            evaluation.same_line_hits,
            evaluation.same_line_total,
            evaluation.separate_line_hits,
            evaluation.separate_line_total,
            evaluation.forbidden_violations
        );
    }

    assert!(dimensions.exact_lines, "corpus lacks exact-line coverage");
    assert!(
        dimensions.required_patterns,
        "corpus lacks required-pattern coverage"
    );
    assert!(
        dimensions.ordered_phrases,
        "corpus lacks ordered-phrase coverage"
    );
    assert!(
        dimensions.same_line_groups,
        "corpus lacks same-line coverage"
    );
    assert!(
        dimensions.separate_line_groups,
        "corpus lacks separate-line coverage"
    );
    assert!(
        dimensions.forbidden_patterns,
        "corpus lacks forbidden-pattern coverage"
    );
    assert!(
        dimensions.allowed_missing_lines,
        "corpus lacks allowed-missing-line coverage"
    );
}

fn read_json<T: DeserializeOwned>(path: &Path) -> T {
    let bytes = fs::read(path)
        .unwrap_or_else(|error| panic!("failed to read `{}`: {error}", display_path(path)));
    serde_json::from_slice(&bytes)
        .unwrap_or_else(|error| panic!("invalid synthetic JSON `{}`: {error}", display_path(path)))
}

fn page_json_paths(fixtures_root: &Path) -> BTreeSet<String> {
    let pages_dir = fixtures_root.join("pages");
    let entries = fs::read_dir(&pages_dir)
        .unwrap_or_else(|error| panic!("failed to read pages directory: {error}"));
    let mut paths = BTreeSet::new();

    for entry in entries {
        let entry = entry.unwrap_or_else(|error| panic!("failed to read pages entry: {error}"));
        let file_type = entry
            .file_type()
            .unwrap_or_else(|error| panic!("failed to inspect pages entry: {error}"));
        assert!(file_type.is_file(), "pages/ may contain only regular files");
        let path = entry.path();
        assert_eq!(
            path.extension(),
            Some(OsStr::new("json")),
            "pages/ may contain only JSON contracts"
        );
        let file_name = path
            .file_name()
            .and_then(OsStr::to_str)
            .expect("page JSON filename must be UTF-8");
        paths.insert(format!("pages/{file_name}"));
    }

    paths
}

fn assert_direct_page_json_path(relative_path: &str) {
    let path = Path::new(relative_path);
    assert!(!path.is_absolute(), "fixture path must be relative");

    let mut components = path.components();
    assert!(
        matches!(components.next(), Some(Component::Normal(part)) if part == OsStr::new("pages")),
        "fixture path must begin with pages/"
    );
    let file_name = match components.next() {
        Some(Component::Normal(file_name)) => file_name,
        _ => panic!("fixture path must name one direct pages/ child"),
    };
    assert!(
        components.next().is_none(),
        "fixture path must name one direct pages/ child"
    );
    assert_eq!(
        Path::new(file_name).extension(),
        Some(OsStr::new("json")),
        "fixture path must end in .json"
    );
}

fn assert_synthetic_pdf_placeholder(pdf: &str) {
    let path = Path::new(pdf);
    assert!(!path.is_absolute(), "PDF placeholder must be relative");

    let mut components = path.components();
    assert!(
        matches!(components.next(), Some(Component::Normal(part)) if part == OsStr::new("synthetic-pdfs")),
        "PDF placeholder must begin with synthetic-pdfs/"
    );
    let file_name = match components.next() {
        Some(Component::Normal(file_name)) => file_name,
        _ => panic!("PDF placeholder must name one direct synthetic-pdfs/ child"),
    };
    assert!(
        components.next().is_none(),
        "PDF placeholder must name one direct synthetic-pdfs/ child"
    );
    let file_path = Path::new(file_name);
    assert_eq!(
        file_path.extension(),
        Some(OsStr::new("pdf")),
        "PDF placeholder must end in .pdf"
    );
    assert!(
        file_path
            .file_stem()
            .and_then(OsStr::to_str)
            .is_some_and(|stem| stem.starts_with("workjet-")),
        "PDF placeholder must use a Workjet-specific name"
    );
}

fn display_path(path: &Path) -> String {
    path.strip_prefix(env!("CARGO_MANIFEST_DIR"))
        .unwrap_or(path)
        .display()
        .to_string()
}
