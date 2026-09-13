package valet.authz
import rego.v1
decision := {"effect":"deny","reasonCode":"clock","matchedRuleIds":[],"obligations":[],"redactions":[]} if time.now_ns() > 0
