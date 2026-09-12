package valet.foundation

import rego.v1

decision := {
  "effect": "allow",
  "reasonCode": "foundation_fixture",
  "matchedRuleIds": ["foundation.explicit_input"],
  "obligations": [],
  "redactions": [],
} if {
  input.principal == "fixture-user"
  count(data.allowed_actions) == 1
  data.allowed_actions[0] == input.action
}
