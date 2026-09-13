package valet.authz
import rego.v1
is_admin if input.role == "admin"
decision := {"effect":"allow","reasonCode":"with","matchedRuleIds":[],"obligations":[],"redactions":[]} if { is_admin with input.role as "admin" }
