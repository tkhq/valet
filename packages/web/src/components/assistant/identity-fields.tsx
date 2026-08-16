import { useState } from "react";
import { Dices } from "lucide-react";
import { Button, Input, Textarea } from "~/components/primitives";
import { useSaveIdentity } from "~/api/orchestrator";

/**
 * Name + personality editing fields for the assistant (assistant-centered
 * web UI, decision 11). Three surfaces mount the same controls: the
 * dashboard shows them full-page-centered on the first visit
 * (`info.name === null`), the identity header reopens them inline and
 * prefilled, and `/settings/assistant` hosts them. `variant` changes the
 * copy and the chrome only, not the behavior.
 *
 * The pure helpers (`pickRandomName`, `appendTraitSentence`,
 * `identitySubmitBody`) live here with the component that calls them.
 */
// 300 unique names, loosely grouped by theme. The reroll is uniform random,
// so ordering doesn't matter — groups exist only to keep curation sane.
// The test suite pins the contract: exactly 300, unique, non-blank.
export const NAME_POOL = [
  // Myth & legend
  "Atlas", "Juno", "Iris", "Echo", "Cleo", "Freya", "Circe", "Athena",
  "Selene", "Thalia", "Orion", "Apollo", "Hermes", "Loki", "Odin", "Saga",
  "Eos", "Rhea", "Gaia", "Nyx", "Helios", "Sibyl", "Titan", "Vesta",
  "Zephyr", "Electra", "Luna", "Minerva", "Phoebe", "Triton", "Calypso",
  "Daphne", "Merlin", "Avalon", "Phoenix", "Griffin",
  // Celestial & space
  "Nova", "Vega", "Lyra", "Cosmo", "Comet", "Astra", "Orbit", "Stella",
  "Aurora", "Celeste", "Halley", "Kepler", "Quasar", "Pulsar", "Nebula",
  "Zenith", "Polaris", "Sirius", "Rigel", "Altair", "Castor", "Pollux",
  "Mira", "Ceres", "Europa", "Callisto",
  "Titania", "Oberon", "Miranda", "Ariel", "Sol",
  // Trees & plants
  "Willow", "Aspen", "Cedar", "Rowan", "Birch", "Maple", "Juniper", "Hazel",
  "Fern", "Ivy", "Moss", "Clover", "Sage", "Basil", "Thyme", "Laurel",
  "Olive", "Poppy", "Dahlia", "Lotus", "Orchid", "Jasmine", "Briar",
  "Heather", "Sylvan", "Sequoia",
  // Land, sea & sky
  "Storm", "Gale", "Breeze", "Frost", "Ember", "Blaze", "Flint", "Ridge",
  "Glen", "Brook",
  "River", "Delta", "Cove", "Reef", "Dune", "Mesa", "Sierra", "Terra",
  "Slate", "Canyon", "Meadow", "Grove", "Ocean", "Marina", "Tide",
  "Harbor", "Haven", "Summit", "Tundra", "Fjord", "Lagoon", "Isla",
  // Birds & beasts
  "Wren", "Lark", "Robin", "Finch", "Sparrow", "Swift", "Falcon", "Hawk",
  "Raven", "Magpie", "Starling", "Kestrel", "Osprey", "Heron", "Dove",
  "Swan", "Crane", "Puffin", "Oriole", "Fox", "Lynx",
  "Otter", "Leo", "Cricket", "Monarch", "Kiwi",
  // Gems & metals
  "Opal", "Ruby", "Jade", "Amber", "Coral", "Pearl", "Onyx", "Topaz",
  "Beryl", "Garnet", "Jasper", "Agate", "Quartz", "Cobalt", "Copper",
  "Silver", "Emerald", "Sterling",
  // Colors & shades
  "Indigo", "Scarlet", "Sienna", "Teal", "Violet", "Ebony",
  "Ivory", "Saffron", "Auburn", "Ginger", "Ash", "Coal",
  // Words & music
  "Fable", "Sonnet", "Ballad", "Lyric", "Quill", "Rune", "Glyph", "Verse",
  "Rhyme", "Tempo", "Aria", "Viola", "Piper", "Melody", "Cadence", "Jazz",
  "Reed", "Harper", "Muse", "Clio", "Puck", "Darcy",
  "Byron", "Bronte", "Waltz", "Tango",
  // Minds & makers
  "Ada", "Hopper", "Curie", "Tesla", "Edison", "Darwin", "Newton", "Sagan",
  "Euler", "Pascal", "Hedy", "Turing", "Pixel",
  "Vector", "Cipher", "Dynamo", "Sprocket", "Gizmo", "Tinker",
  // Places afar
  "Rio", "Cairo", "Milan", "Kyoto", "Oslo", "Geneva", "Verona", "Dakota",
  "Denali", "Everest", "Fuji", "Sahara", "Hudson",
  "Capri", "Malta", "Havana", "Lisbon", "Porto", "Bali",
  "Kona", "Maui", "Tahiti", "Fiji", "Samoa",
  // Kitchen & cupboard
  "Biscuit", "Waffle", "Pepper", "Nutmeg", "Cocoa", "Mocha", "Chai",
  "Wasabi", "Plum", "Fig", "Mango", "Berry", "Honey", "Mochi",
  "Pesto", "Clove", "Truffle",
  // Spark & spirit
  "Beacon", "Dash", "Quinn", "Ziggy", "Sunny", "Lucky", "Chance", "Scout",
  "Pilot", "Ranger", "Rover", "Nomad", "Ace", "Bolt", "Spark", "Blitz",
  "Pip", "Domino", "Gambit",
  "Kite", "Compass", "Anchor", "Merit", "Valor", "Verity", "Amity",
  "Bliss", "Honor", "Liberty", "Noble", "Pax", "Solace", "Moxie",
] as const;

export const TRAIT_CHIPS = [
  "warm and direct",
  "dry wit",
  "meticulous planner",
  "cheerful hype-person",
] as const;

/** Pure so a reroll's randomness is testable without mounting React. */
export function pickRandomName(
  pool: readonly string[] = NAME_POOL,
  exclude?: string,
  random: () => number = Math.random,
): string {
  const candidates = exclude ? pool.filter((n) => n !== exclude) : pool;
  const source = candidates.length > 0 ? candidates : pool;
  return source[Math.floor(random() * source.length)] ?? source[0];
}

/**
 * Appends a chip's phrase sentence ("You are {trait}.") to the current
 * personality text. Composable: clicking multiple chips (or typing free
 * text, then clicking a chip) keeps appending.
 */
export function appendTraitSentence(current: string, trait: string): string {
  const sentence = `You are ${trait}.`;
  const trimmed = current.trimEnd();
  return trimmed.length === 0 ? sentence : `${trimmed} ${sentence}`;
}

/**
 * Pure PATCH-body derivation, extracted so the "Skip personality" path
 * (submit name only, ignoring whatever's typed in the textarea) is
 * testable without mounting the mutation. `withPersonality: false` always
 * omits `personality`, regardless of its content; `true` omits it only
 * when the field is blank.
 */
export function identitySubmitBody(
  name: string,
  personality: string,
  withPersonality: boolean,
): { name: string; personality?: string } {
  const trimmedName = name.trim();
  const trimmedPersonality = personality.trim();
  if (withPersonality && trimmedPersonality.length > 0) {
    return { name: trimmedName, personality: trimmedPersonality };
  }
  return { name: trimmedName };
}

export interface IdentityFieldsProps {
  initialName?: string | null;
  initialPersonality?: string | null;
  /** "onboarding" = first-visit full-page copy; "edit"/"settings" = quieter chrome. */
  variant?: "onboarding" | "edit" | "settings";
  onDone?: () => void;
  onCancel?: () => void;
  /** Hide the heading/subhead (settings already renders its own `Section` heading). */
  hideHeading?: boolean;
  className?: string;
}

export function IdentityFields({
  initialName,
  initialPersonality,
  variant = "onboarding",
  onDone,
  onCancel,
  hideHeading = false,
  className,
}: IdentityFieldsProps) {
  const [name, setName] = useState(() => initialName || pickRandomName());
  const [personality, setPersonality] = useState(initialPersonality ?? "");
  const save = useSaveIdentity();

  const trimmedName = name.trim();
  const canSubmit = trimmedName.length > 0 && !save.isPending;

  async function submit(withPersonality: boolean) {
    if (!canSubmit) return;
    const body = identitySubmitBody(name, personality, withPersonality);
    try {
      await save.mutateAsync(body);
      onDone?.();
    } catch (err) {
      console.error("failed to save identity:", err);
    }
  }

  return (
    <div className={className}>
      <div className="space-y-6">
        {!hideHeading && (
          <div className="space-y-1">
            <h1 className="font-display text-2xl text-ink">
              {variant === "onboarding" ? "Meet your assistant" : "Rename your assistant"}
            </h1>
            <p className="text-sm text-muted">Give them a voice — you can change this anytime.</p>
          </div>
        )}

        <div className="space-y-2">
          <label htmlFor="assistant-name" className="text-xs font-medium text-muted">
            Name
          </label>
          <div className="flex gap-2">
            <Input
              id="assistant-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name your assistant"
              autoFocus={variant === "onboarding"}
              className="flex-1"
            />
            <Button
              type="button"
              variant="secondary"
              size="md"
              aria-label="Suggest another name"
              onClick={() => setName((current) => pickRandomName(NAME_POOL, current))}
            >
              <Dices className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          <label htmlFor="assistant-personality" className="text-xs font-medium text-muted">
            Personality (optional)
          </label>
          <div className="flex flex-wrap gap-1.5">
            {TRAIT_CHIPS.map((trait) => (
              <button
                key={trait}
                type="button"
                onClick={() => setPersonality((current) => appendTraitSentence(current, trait))}
                className="rounded-full border border-line px-2.5 py-1 text-xs text-muted hover:border-moss hover:text-ink transition-colors"
              >
                {trait}
              </button>
            ))}
          </div>
          <Textarea
            id="assistant-personality"
            value={personality}
            onChange={(e) => setPersonality(e.target.value)}
            placeholder="You are warm and direct. Or write your own."
            rows={3}
          />
        </div>

        {save.error && (
          <div className="rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-xs text-danger-600">
            {save.error.message}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button type="button" onClick={() => submit(true)} disabled={!canSubmit}>
            {variant === "onboarding" ? "Start" : "Save"}
          </Button>
          <Button type="button" variant="ghost" onClick={() => submit(false)} disabled={!canSubmit}>
            Skip personality
          </Button>
          {variant === "edit" && onCancel && (
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
