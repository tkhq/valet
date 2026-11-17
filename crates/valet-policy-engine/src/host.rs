/// The PR 4 interpreter has no host capabilities.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct EmptyHost;

impl EmptyHost {
    pub const fn capabilities(self) -> &'static [&'static str] {
        &[]
    }
}
