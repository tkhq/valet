use crate::compatibility::{
    CAPABILITY_PROFILE_VERSION, ENGINE_CONTRACT_VERSION, ENGINE_NAME, ENGINE_VERSION,
    REGORUS_REVISION, REGORUS_VERSION, REGO_VERSION,
};
use crate::provenance::ProvenanceMap;
use crate::source_bundle::{
    BundleCompatibility, LoadedSourceBundle, SourceBundle, SourceMetadata, SourceModule,
    REQUIRED_ENTRYPOINT,
};
use crate::EngineError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const SOURCE_BUNDLE_SCHEMA_VERSION: u32 = 1;
pub const SOURCE_BUNDLE_MEDIA_TYPE: &str = "application/vnd.valet.policy-source-bundle.v1+json";
pub const REGO_MEDIA_TYPE: &str = "application/vnd.valet.rego.v1";
pub const JSON_MEDIA_TYPE: &str = "application/json";
pub const PROVENANCE_MEDIA_TYPE: &str = "application/vnd.valet.policy-provenance.v1+json";
const SOURCE_BUNDLE_DOMAIN: &[u8] = b"valet.source-bundle.v1\0";
const POLICY_DOMAIN: &[u8] = b"valet.policy.v1\0";

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InterpreterIdentity {
    pub name: String,
    pub version: String,
    pub revision: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BundleSourceMetadata {
    pub origin: String,
    pub license: String,
    pub revision: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestFileEntry {
    pub path: String,
    pub media_type: String,
    pub byte_length: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceBundleManifestV1 {
    pub schema_version: u32,
    pub media_type: String,
    pub policy_version: String,
    pub engine_name: String,
    pub engine_version: String,
    pub capability_profile_version: u32,
    pub interpreter: InterpreterIdentity,
    pub contract_version: u32,
    pub rego_version: String,
    pub entrypoint: String,
    pub source: BundleSourceMetadata,
    pub files: Vec<ManifestFileEntry>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SourceBundleFile {
    pub path: String,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CanonicalSourceBundle {
    pub manifest_json: String,
    pub files: Vec<SourceBundleFile>,
}

#[derive(Clone, Debug)]
pub struct ValidatedSourceBundle {
    pub manifest: SourceBundleManifestV1,
    pub canonical_manifest_json: String,
    pub source_bundle_digest: String,
    pub policy_digest: String,
    pub loaded: LoadedSourceBundle,
}

impl SourceBundleManifestV1 {
    pub fn current(
        policy_version: String,
        source: BundleSourceMetadata,
        mut files: Vec<ManifestFileEntry>,
    ) -> Self {
        files.sort_by(|left, right| left.path.as_bytes().cmp(right.path.as_bytes()));
        Self {
            schema_version: SOURCE_BUNDLE_SCHEMA_VERSION,
            media_type: SOURCE_BUNDLE_MEDIA_TYPE.to_owned(),
            policy_version,
            engine_name: ENGINE_NAME.to_owned(),
            engine_version: ENGINE_VERSION.to_owned(),
            capability_profile_version: CAPABILITY_PROFILE_VERSION,
            interpreter: InterpreterIdentity {
                name: "regorus".to_owned(),
                version: REGORUS_VERSION.to_owned(),
                revision: REGORUS_REVISION.to_owned(),
            },
            contract_version: ENGINE_CONTRACT_VERSION,
            rego_version: REGO_VERSION.to_owned(),
            entrypoint: REQUIRED_ENTRYPOINT.to_owned(),
            source,
            files,
        }
    }

    pub fn canonical_json(&self) -> Result<String, EngineError> {
        serde_jcs::to_string(self).map_err(|error| EngineError::BundleManifest(error.to_string()))
    }
}

impl CanonicalSourceBundle {
    pub fn validate(&self) -> Result<ValidatedSourceBundle, EngineError> {
        let limits = crate::capability_profile()?.limits.enforced;
        let bundle_bytes = self
            .files
            .iter()
            .fold(self.manifest_json.len(), |total, file| {
                total
                    .saturating_add(file.path.len())
                    .saturating_add(file.bytes.len())
            });
        if bundle_bytes > limits.max_source_bundle_bytes {
            return Err(EngineError::SourceBundleLimit {
                actual: bundle_bytes,
                limit: limits.max_source_bundle_bytes,
            });
        }
        if self.files.len() > limits.max_modules.saturating_add(2) {
            return Err(EngineError::ModuleCountLimit {
                actual: self.files.len().saturating_sub(2),
                limit: limits.max_modules,
            });
        }
        let manifest: SourceBundleManifestV1 = serde_json::from_str(&self.manifest_json)
            .map_err(|error| EngineError::BundleManifest(error.to_string()))?;
        let canonical_manifest_json = manifest.canonical_json()?;
        if canonical_manifest_json != self.manifest_json {
            return Err(EngineError::NonCanonicalBundleManifest);
        }
        validate_manifest_identity(&manifest)?;
        validate_manifest_entries(&manifest.files)?;

        let mut supplied = BTreeMap::new();
        for file in &self.files {
            validate_path(&file.path)?;
            if supplied
                .insert(file.path.as_str(), file.bytes.as_slice())
                .is_some()
            {
                return Err(EngineError::DuplicateBundlePath(file.path.clone()));
            }
        }
        if supplied.len() != manifest.files.len() {
            return Err(EngineError::BundleFileSetMismatch);
        }

        let mut modules = Vec::new();
        let mut data_json: Option<String> = None;
        let mut provenance: Option<ProvenanceMap> = None;
        for entry in &manifest.files {
            let bytes = supplied
                .remove(entry.path.as_str())
                .ok_or_else(|| EngineError::MissingBundleFile(entry.path.clone()))?;
            let actual_length = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
            if actual_length != entry.byte_length {
                return Err(EngineError::BundleLengthMismatch {
                    path: entry.path.clone(),
                    expected: entry.byte_length,
                    actual: actual_length,
                });
            }
            let actual_digest = sha256_hex(bytes);
            if actual_digest != entry.sha256 {
                return Err(EngineError::BundleDigestMismatch(entry.path.clone()));
            }
            match entry.media_type.as_str() {
                REGO_MEDIA_TYPE => {
                    let source = std::str::from_utf8(bytes)
                        .map_err(|_| EngineError::InvalidRegoUtf8(entry.path.clone()))?;
                    validate_lf_source(source, &entry.path)?;
                    modules.push(SourceModule {
                        id: entry.path.clone(),
                        source: source.to_owned(),
                        metadata: SourceMetadata {
                            origin: manifest.source.origin.clone(),
                            license: manifest.source.license.clone(),
                            revision: manifest.source.revision.clone(),
                        },
                    });
                }
                JSON_MEDIA_TYPE => {
                    if data_json.is_some() {
                        return Err(EngineError::DuplicateBundleRole("policy data"));
                    }
                    data_json = Some(canonical_json_file(bytes, &entry.path)?);
                }
                PROVENANCE_MEDIA_TYPE => {
                    if provenance.is_some() {
                        return Err(EngineError::DuplicateBundleRole("provenance"));
                    }
                    let json = canonical_json_file(bytes, &entry.path)?;
                    provenance = Some(
                        serde_json::from_str(&json)
                            .map_err(|error| EngineError::Provenance(error.to_string()))?,
                    );
                }
                _ => {
                    return Err(EngineError::UnsupportedBundleMediaType(
                        entry.media_type.clone(),
                    ))
                }
            }
        }
        if modules.is_empty() {
            return Err(EngineError::MissingModules);
        }
        let data_json = data_json.ok_or(EngineError::MissingBundleRole("policy data"))?;
        let provenance = provenance.ok_or(EngineError::MissingBundleRole("provenance"))?;
        modules.sort_by(|left, right| left.id.as_bytes().cmp(right.id.as_bytes()));
        let source_bundle_digest = digest_bundle(
            SOURCE_BUNDLE_DOMAIN,
            &canonical_manifest_json,
            &manifest.files,
            &self.files,
        )?;
        let policy_digest = digest_bundle(
            POLICY_DOMAIN,
            &canonical_manifest_json,
            &manifest.files,
            &self.files,
        )?;
        let loaded = LoadedSourceBundle::load(SourceBundle {
            compatibility: BundleCompatibility::current(),
            modules,
            data_json,
            provenance,
        })?;
        Ok(ValidatedSourceBundle {
            manifest,
            canonical_manifest_json,
            source_bundle_digest,
            policy_digest,
            loaded,
        })
    }
}

pub fn manifest_entry(path: String, media_type: String, bytes: &[u8]) -> ManifestFileEntry {
    ManifestFileEntry {
        path,
        media_type,
        byte_length: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
        sha256: sha256_hex(bytes),
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn validate_manifest_identity(manifest: &SourceBundleManifestV1) -> Result<(), EngineError> {
    let expected = SourceBundleManifestV1::current(
        manifest.policy_version.clone(),
        manifest.source.clone(),
        manifest.files.clone(),
    );
    macro_rules! check {
        ($field:ident) => {
            if manifest.$field != expected.$field {
                return Err(EngineError::IncompatibleBundle {
                    field: stringify!($field),
                    expected: expected.$field.to_string(),
                    actual: manifest.$field.to_string(),
                });
            }
        };
    }
    check!(schema_version);
    check!(media_type);
    check!(engine_name);
    check!(engine_version);
    check!(capability_profile_version);
    check!(contract_version);
    check!(rego_version);
    check!(entrypoint);
    if manifest.interpreter != expected.interpreter {
        return Err(EngineError::IncompatibleBundle {
            field: "interpreter",
            expected: format!(
                "{}@{}#{}",
                expected.interpreter.name,
                expected.interpreter.version,
                expected.interpreter.revision
            ),
            actual: format!(
                "{}@{}#{}",
                manifest.interpreter.name,
                manifest.interpreter.version,
                manifest.interpreter.revision
            ),
        });
    }
    if manifest.policy_version.is_empty()
        || manifest.source.origin.is_empty()
        || manifest.source.license.is_empty()
    {
        return Err(EngineError::BundleManifest(
            "policyVersion and source metadata must be non-empty".to_owned(),
        ));
    }
    Ok(())
}

fn validate_manifest_entries(entries: &[ManifestFileEntry]) -> Result<(), EngineError> {
    let mut prior: Option<&[u8]> = None;
    let mut paths = BTreeSet::new();
    for entry in entries {
        validate_path(&entry.path)?;
        if entry.sha256.len() != 64
            || !entry
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(EngineError::InvalidBundleDigest(entry.path.clone()));
        }
        if !paths.insert(entry.path.as_str()) {
            return Err(EngineError::DuplicateBundlePath(entry.path.clone()));
        }
        if prior.is_some_and(|value| value >= entry.path.as_bytes()) {
            return Err(EngineError::UnsortedBundlePaths);
        }
        prior = Some(entry.path.as_bytes());
    }
    Ok(())
}

fn validate_path(path: &str) -> Result<(), EngineError> {
    let valid = !path.is_empty()
        && !path.starts_with('/')
        && !path.starts_with('\\')
        && !path.contains('\\')
        && !path.contains('\0')
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..");
    if valid {
        Ok(())
    } else {
        Err(EngineError::InvalidBundlePath(path.to_owned()))
    }
}

fn validate_lf_source(source: &str, path: &str) -> Result<(), EngineError> {
    if source.contains('\r') || (!source.is_empty() && !source.ends_with('\n')) {
        Err(EngineError::NonLfRego(path.to_owned()))
    } else {
        Ok(())
    }
}

fn canonical_json_file(bytes: &[u8], path: &str) -> Result<String, EngineError> {
    let input =
        std::str::from_utf8(bytes).map_err(|_| EngineError::InvalidBundleUtf8(path.to_owned()))?;
    let value: serde_json::Value =
        serde_json::from_str(input).map_err(|error| EngineError::InvalidJson(error.to_string()))?;
    let canonical = serde_jcs::to_string(&value)
        .map_err(|error| EngineError::InvalidJson(error.to_string()))?;
    if canonical.as_bytes() != bytes {
        return Err(EngineError::NonCanonicalJson);
    }
    Ok(canonical)
}

fn digest_bundle(
    domain: &[u8],
    manifest_json: &str,
    entries: &[ManifestFileEntry],
    files: &[SourceBundleFile],
) -> Result<String, EngineError> {
    let by_path: BTreeMap<&str, &[u8]> = files
        .iter()
        .map(|file| (file.path.as_str(), file.bytes.as_slice()))
        .collect();
    let mut digest = Sha256::new();
    digest.update(domain);
    digest.update((manifest_json.len() as u64).to_be_bytes());
    digest.update(manifest_json.as_bytes());
    for entry in entries {
        let bytes = by_path
            .get(entry.path.as_str())
            .ok_or_else(|| EngineError::MissingBundleFile(entry.path.clone()))?;
        digest.update((entry.path.len() as u64).to_be_bytes());
        digest.update(entry.path.as_bytes());
        digest.update((bytes.len() as u64).to_be_bytes());
        digest.update(bytes);
    }
    Ok(format!("{:x}", digest.finalize()))
}
