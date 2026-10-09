import type { PluginSummary } from "@valet/api/wire";
import { displayName } from "./display-name";

/** Manifest capabilities, separate from the account's connection and access checks. */
export function IntegrationDetails({ plugin }: { plugin: PluginSummary }) {
  const services = plugin.actionServices ?? plugin.services.map((service) => ({
    service: service.service, actions: service.actions, dynamic: service.dynamic,
  }));
  return <details className="mt-4 min-w-0 border-t border-line pt-3 text-sm">
    <summary className="cursor-pointer py-1 text-muted">Tools and skills</summary>
    <div className="mt-3 space-y-4">
      <p className="text-xs text-muted">Tools that use an account need a usable connection and access to the requested files or resources.</p>
      {services.map((service) => <div key={service.service}>
        <h4 className="text-xs font-medium text-ink">{displayName(service.service)} tools</h4>
        {service.actions.length > 0 ? <ul className="mt-2 max-h-64 space-y-2 overflow-y-auto pr-2 text-xs">
          {service.actions.map((action) => <li key={action.id} className="flex items-start justify-between gap-3">
            <span className="min-w-0 break-words">{action.name}</span>
            {action.requiresApproval && <span className="shrink-0 text-muted">Approval required</span>}
          </li>)}
        </ul> : <p className="mt-1 text-xs text-muted">{service.dynamic ? "Tools are discovered when connected." : "No tools declared for this service."}</p>}
        {service.dynamic && service.actions.length > 0 && <p className="mt-2 text-xs text-muted">More tools may be discovered when connected.</p>}
      </div>)}
      {plugin.services.some((service) => service.scopes?.length) && <details>
        <summary className="cursor-pointer text-xs text-muted">Requested permissions</summary>
        <p className="mt-2 text-xs text-muted">These permissions are requested by the plugin. They do not confirm the current account's grants or file access.</p>
        <ul className="mt-2 max-h-40 overflow-y-auto text-xs text-muted">
          {[...new Set(plugin.services.flatMap((service) => service.scopes ?? []))].map((scope) => <li key={scope} className="break-all py-1">{scope}</li>)}
        </ul>
      </details>}
      <div>
        <h4 className="text-xs font-medium text-ink">Related skills</h4>
        {plugin.skills?.length ? <ul className="mt-2 space-y-2">
          {plugin.skills.map((skill) => <li key={skill.name}>
            <a className="break-words text-xs text-moss underline underline-offset-2" href={`/skills/${encodeURIComponent(skill.name)}`}>{displayName(skill.name)}</a>
            {skill.description && <p className="mt-1 text-xs text-muted">{skill.description}</p>}
          </li>)}
        </ul> : <p className="mt-1 text-xs text-muted">{plugin.skills ? "This plugin does not include a skill." : "Skill details are unavailable. Open Skills to browse installed playbooks."}</p>}
      </div>
    </div>
  </details>;
}
