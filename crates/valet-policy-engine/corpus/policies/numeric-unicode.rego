package valet.authz
import rego.v1
decision := {"effect":"allow","reasonCode":"numeric_unicode","matchedRuleIds":[],"obligations":[],"redactions":[]} if { 1.5 + 1.5 == 3; count("Grüße") == 5 }
