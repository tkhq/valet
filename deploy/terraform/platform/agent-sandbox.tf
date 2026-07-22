# The vendored agent-sandbox release manifest — the same file
# `make k8s-sandbox-install` applies locally. Never a floating upstream URL.
data "kubectl_file_documents" "agent_sandbox" {
  content = file("${path.module}/../../agent-sandbox/v0.5.1/manifest.yaml")
}

resource "kubectl_manifest" "agent_sandbox" {
  for_each  = data.kubectl_file_documents.agent_sandbox.manifests
  yaml_body = each.value

  # CRDs and webhook certs live in one manifest: apply server-side and
  # tolerate the controller re-writing caBundle fields.
  server_side_apply = true
  wait              = true
}
