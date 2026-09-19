// The harness mark on the left of the card — in the project badge's column, so
// without indent. The host knows the logos; we draw none of our own.
//
// Desaturated: in this list exactly two colours carry meaning (blue waits, red
// failed). A colourful brand logo next to them shouts without saying anything —
// it only answers "which harness", and the shape alone does that.
import {
  experimental_ProviderIcon as ProviderIcon,
  type PluginProvidersState,
} from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";

export type ProviderMap = ReadonlyMap<
  string,
  PluginProvidersState["providers"][number]
>;

export function buildProviderMap(
  providers: PluginProvidersState["providers"],
): ProviderMap {
  return new Map(providers.map((provider) => [provider.id, provider]));
}

export function ProviderGlyph({
  providerId,
  providers,
  className,
}: {
  providerId: string;
  providers: ProviderMap;
  className?: string;
}) {
  const provider = providers.get(providerId);
  return (
    <span
      className={cn(
        "flex size-3.5 shrink-0 items-center justify-center text-muted-foreground/80 opacity-80 [filter:grayscale(1)]",
        className,
      )}
    >
      <ProviderIcon
        providerKind="agent"
        provider={provider ?? { id: providerId }}
        className="size-3.5 text-muted-foreground [filter:grayscale(1)] [&_*]:![color:currentColor]"
      />
    </span>
  );
}
