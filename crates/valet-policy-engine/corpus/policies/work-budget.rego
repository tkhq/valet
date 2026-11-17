package valet.authz
import rego.v1
decision := {"effect":"deny","reasonCode":"range","matchedRuleIds":[],"obligations":[],"redactions":[]} if count(numbers.range(0, 10000000)) > 0
