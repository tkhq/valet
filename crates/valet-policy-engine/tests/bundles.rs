use valet_policy_engine::{
    manifest_entry, BundleSourceMetadata, CanonicalSourceBundle, EngineError, SourceBundleFile,
    SourceBundleManifestV1, JSON_MEDIA_TYPE, PROVENANCE_MEDIA_TYPE, REGO_MEDIA_TYPE,
};

const POLICY: &[u8] = br#"package valet.authz
import rego.v1
decision := {
  "effect": "allow",
  "reasonCode": "bundle_test",
  "matchedRuleIds": ["bundle.test"],
  "obligations": [],
  "redactions": [],
}
"#;
const DATA: &[u8] = br#"{"enabled":true}"#;
const PROVENANCE: &[u8] = br#"{"entries":[]}"#;

fn valid_bundle() -> CanonicalSourceBundle {
    let files = vec![
        SourceBundleFile {
            path: "data/policy.json".to_owned(),
            bytes: DATA.to_vec(),
        },
        SourceBundleFile {
            path: "policies/main.rego".to_owned(),
            bytes: POLICY.to_vec(),
        },
        SourceBundleFile {
            path: "provenance/map.json".to_owned(),
            bytes: PROVENANCE.to_vec(),
        },
    ];
    let manifest = SourceBundleManifestV1::current(
        "test-v1".to_owned(),
        BundleSourceMetadata {
            origin: "valet-test".to_owned(),
            license: "UNLICENSED".to_owned(),
            revision: Some("test".to_owned()),
        },
        vec![
            manifest_entry(
                files[0].path.clone(),
                JSON_MEDIA_TYPE.to_owned(),
                &files[0].bytes,
            ),
            manifest_entry(
                files[1].path.clone(),
                REGO_MEDIA_TYPE.to_owned(),
                &files[1].bytes,
            ),
            manifest_entry(
                files[2].path.clone(),
                PROVENANCE_MEDIA_TYPE.to_owned(),
                &files[2].bytes,
            ),
        ],
    );
    CanonicalSourceBundle {
        manifest_json: manifest.canonical_json().unwrap(),
        files,
    }
}

#[test]
fn canonical_bundle_validates_and_has_distinct_stable_identities() {
    let first = valid_bundle().validate().unwrap();
    let second = valid_bundle().validate().unwrap();
    assert_eq!(first.source_bundle_digest, second.source_bundle_digest);
    assert_eq!(first.policy_digest, second.policy_digest);
    assert_ne!(first.source_bundle_digest, first.policy_digest);
    assert_eq!(first.source_bundle_digest.len(), 64);
    assert_eq!(
        first.source_bundle_digest,
        "00c9429b95b2aa7ae9fec08a8aaba218cedaeae3ccb8510eea17b06de7ccd6d7"
    );
    assert_eq!(
        first.policy_digest,
        "b5630487e46169e6038b3f0fe2a0cb8109ccb3c6ce5f9ab8f96c8b313ef59a13"
    );
}

#[test]
fn changed_declared_bytes_change_both_identities() {
    let original = valid_bundle().validate().unwrap();
    let mut changed = valid_bundle();
    changed.files[0].bytes = br#"{"enabled":false}"#.to_vec();
    let mut manifest: SourceBundleManifestV1 =
        serde_json::from_str(&changed.manifest_json).unwrap();
    manifest.files[0] = manifest_entry(
        changed.files[0].path.clone(),
        JSON_MEDIA_TYPE.to_owned(),
        &changed.files[0].bytes,
    );
    changed.manifest_json = manifest.canonical_json().unwrap();
    let changed = changed.validate().unwrap();
    assert_ne!(original.policy_digest, changed.policy_digest);
    assert_ne!(original.source_bundle_digest, changed.source_bundle_digest);
}

#[test]
fn malformed_or_corrupt_bundles_fail_closed() {
    let mut traversal = valid_bundle();
    traversal.files[0].path = "../data.json".to_owned();
    assert!(matches!(
        traversal.validate(),
        Err(EngineError::InvalidBundlePath(_))
    ));

    let mut corrupt = valid_bundle();
    corrupt.files[0].bytes.push(b' ');
    assert!(matches!(
        corrupt.validate(),
        Err(EngineError::BundleLengthMismatch { .. })
    ));

    let mut missing_provenance = valid_bundle();
    missing_provenance.files.pop();
    let mut manifest: SourceBundleManifestV1 =
        serde_json::from_str(&missing_provenance.manifest_json).unwrap();
    manifest.files.pop();
    missing_provenance.manifest_json = manifest.canonical_json().unwrap();
    assert!(matches!(
        missing_provenance.validate(),
        Err(EngineError::MissingBundleRole("provenance"))
    ));

    let mut noncanonical = valid_bundle();
    noncanonical.manifest_json.push('\n');
    assert!(matches!(
        noncanonical.validate(),
        Err(EngineError::NonCanonicalBundleManifest)
    ));

    for (field, mutate) in [
        (
            "engine_version",
            (|manifest: &mut SourceBundleManifestV1| manifest.engine_version = "999".to_owned())
                as fn(&mut SourceBundleManifestV1),
        ),
        ("rego_version", |manifest: &mut SourceBundleManifestV1| {
            manifest.rego_version = "v0".to_owned()
        }),
        ("interpreter", |manifest: &mut SourceBundleManifestV1| {
            manifest.interpreter.revision = "unpinned".to_owned()
        }),
    ] {
        let mut incompatible = valid_bundle();
        let mut manifest: SourceBundleManifestV1 =
            serde_json::from_str(&incompatible.manifest_json).unwrap();
        mutate(&mut manifest);
        incompatible.manifest_json = manifest.canonical_json().unwrap();
        assert!(matches!(
            incompatible.validate(),
            Err(EngineError::IncompatibleBundle { field: actual, .. }) if actual == field
        ));
    }
}

#[test]
fn source_capabilities_are_revalidated() {
    let mut bundle = valid_bundle();
    bundle.files[1].bytes =
        b"package valet.authz\nimport rego.v1\ndecision := time.now_ns()\n".to_vec();
    let mut manifest: SourceBundleManifestV1 = serde_json::from_str(&bundle.manifest_json).unwrap();
    manifest.files[1] = manifest_entry(
        bundle.files[1].path.clone(),
        REGO_MEDIA_TYPE.to_owned(),
        &bundle.files[1].bytes,
    );
    bundle.manifest_json = manifest.canonical_json().unwrap();
    assert!(matches!(
        bundle.validate(),
        Err(EngineError::RejectedBuiltin(name)) if name == "time.now_ns"
    ));
}

#[test]
fn json_and_rego_canonical_forms_are_enforced() {
    let mut noncanonical_data = valid_bundle();
    noncanonical_data.files[0].bytes = br#"{ "enabled": true }"#.to_vec();
    let mut manifest: SourceBundleManifestV1 =
        serde_json::from_str(&noncanonical_data.manifest_json).unwrap();
    manifest.files[0] = manifest_entry(
        noncanonical_data.files[0].path.clone(),
        JSON_MEDIA_TYPE.to_owned(),
        &noncanonical_data.files[0].bytes,
    );
    noncanonical_data.manifest_json = manifest.canonical_json().unwrap();
    assert!(matches!(
        noncanonical_data.validate(),
        Err(EngineError::NonCanonicalJson)
    ));

    let mut crlf = valid_bundle();
    crlf.files[1].bytes = std::str::from_utf8(POLICY)
        .unwrap()
        .replace('\n', "\r\n")
        .into_bytes();
    let mut manifest: SourceBundleManifestV1 = serde_json::from_str(&crlf.manifest_json).unwrap();
    manifest.files[1] = manifest_entry(
        crlf.files[1].path.clone(),
        REGO_MEDIA_TYPE.to_owned(),
        &crlf.files[1].bytes,
    );
    crlf.manifest_json = manifest.canonical_json().unwrap();
    assert!(matches!(crlf.validate(), Err(EngineError::NonLfRego(_))));
}
