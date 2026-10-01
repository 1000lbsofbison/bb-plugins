/**
 * The run-level model check, kept free of the SDK so both outcomes can be
 * tested without a plugin host.
 *
 * Why per provider: `providers.models()` without a `providerId` answers with
 * the catalogue of the environment's *default* provider only (BBP-21: the
 * crew-sandbox environment returned three pi models, none from claude-code),
 * so a node naming any other provider's model was refused although BB lists
 * it. Each named provider is therefore asked for its own catalogue.
 */

/** The part of `providers.models()`' answer this check reads. */
export type ModelCatalog = {
  providers: { id: string; available: boolean }[];
  models: { id: string; model: string }[];
  modelLoadError?: { providerId: string; code: string; detail: string | null } | null;
};

export type WantedModel = { label: string; providerId: string; model: string };

export type ModelCheck = {
  /** Definite mismatches: the run must not start. */
  problems: string[];
  /** Questions the catalogue could not answer: logged, the run goes ahead. */
  warnings: string[];
};

export async function checkModels(
  wanted: WantedModel[],
  loadCatalog: (providerId: string) => Promise<ModelCatalog>,
): Promise<ModelCheck> {
  const problems: string[] = [];
  const warnings: string[] = [];

  const catalogs = new Map<string, Promise<ModelCatalog | Error>>();
  const catalogFor = (providerId: string) => {
    let entry = catalogs.get(providerId);
    if (!entry) {
      entry = loadCatalog(providerId).catch((cause: unknown) =>
        cause instanceof Error ? cause : new Error(String(cause)),
      );
      catalogs.set(providerId, entry);
    }
    return entry;
  };

  for (const node of wanted) {
    const catalog = await catalogFor(node.providerId);
    if (catalog instanceof Error) {
      warnings.push(
        `"${node.label}": catalogue of "${node.providerId}" unreadable (${catalog.message}), model "${node.model}" not checked`,
      );
      continue;
    }
    const provider = catalog.providers.find((entry) => entry.id === node.providerId);
    if (!provider || !provider.available) {
      problems.push(
        `"${node.label}" names the provider "${node.providerId}", which this machine does not offer`,
      );
      continue;
    }
    const loadError =
      catalog.modelLoadError && catalog.modelLoadError.providerId === node.providerId
        ? catalog.modelLoadError
        : null;
    // An empty or failed catalogue is an unanswered question, not a "no":
    // refusing here would stop runs that would work once the provider answers.
    if (loadError || catalog.models.length === 0) {
      warnings.push(
        `"${node.label}": catalogue of "${node.providerId}" is ${
          loadError ? `unavailable (${loadError.code})` : "empty"
        }, model "${node.model}" not checked`,
      );
      continue;
    }
    // A catalogue entry carries both an id and the provider-facing model name;
    // either is a legitimate thing for a stored graph to name.
    const known = catalog.models.some(
      (entry) => entry.id === node.model || entry.model === node.model,
    );
    if (!known) {
      problems.push(
        `"${node.label}" names the model "${node.model}", which does not appear in the catalogue of "${node.providerId}"`,
      );
    }
  }
  return { problems, warnings };
}
