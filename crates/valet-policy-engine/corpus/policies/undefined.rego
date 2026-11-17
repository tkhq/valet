package valet.authz
import rego.v1
default decision := {"effect":"deny","reasonCode":"undefined","matchedRuleIds":[],"obligations":[],"redactions":[]}
decision := {"effect":"allow","reasonCode":"defined","matchedRuleIds":[],"obligations":[],"redactions":[]} if input.missing
