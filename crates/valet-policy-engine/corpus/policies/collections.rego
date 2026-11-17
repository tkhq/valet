package valet.authz
import rego.v1
values := {x | some x in [1, 2, 2, 3]}
selected := [x | some x in values; x > 1]
decision := {"effect":"allow","reasonCode":"collections","matchedRuleIds":[],"obligations":[],"redactions":[]} if { count(values) == 3; count(selected) == 2; {"key": selected}.key[0] == 2 }
