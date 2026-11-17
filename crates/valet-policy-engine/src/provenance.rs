use crate::source_bundle::SourceModule;
use crate::EngineError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProvenanceMap {
    pub entries: Vec<ProvenanceEntry>,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProvenanceEntry {
    pub module_id: String,
    pub rule_id: String,
    pub source_id: String,
    pub start_line: u32,
    pub end_line: u32,
}

impl ProvenanceMap {
    pub(crate) fn validate(&self, modules: &[SourceModule]) -> Result<(), EngineError> {
        let ids: BTreeSet<_> = modules.iter().map(|module| module.id.as_str()).collect();
        for entry in &self.entries {
            if !ids.contains(entry.module_id.as_str()) {
                return Err(EngineError::Provenance(format!(
                    "module `{}` does not exist",
                    entry.module_id
                )));
            }
            if entry.rule_id.is_empty()
                || entry.source_id.is_empty()
                || entry.start_line == 0
                || entry.end_line < entry.start_line
            {
                return Err(EngineError::Provenance(format!(
                    "entry for module `{}` has an invalid rule, source, or line range",
                    entry.module_id
                )));
            }
        }
        Ok(())
    }
}
