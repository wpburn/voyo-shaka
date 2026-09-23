import {
  type DiscoveryScope,
  DiscoveryStore,
  parseDiscoveryEntries,
} from "./voyo-shaka.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`expected ${expectedJson}, got ${actualJson}`);
  }
}

function section(
  name: string,
  content: unknown[],
): { name: string; content: unknown[] } {
  return { name, content };
}

function item(id: string, title = id): Record<string, unknown> {
  return {
    id,
    title,
    image: "https://img/{WIDTH}x{HEIGHT}/cover.jpg",
    releaseDateLabel: "24 Aug",
    labels: [{ type: "live", text: "LIVE" }],
  };
}

Deno.test("parses direct Sport carousel items and deduplicates typed IDs", () => {
  const entries = parseDiscoveryEntries([
    section("Other", [item("episode-1")]),
    section("Sport Live", [
      item("episode-139785", "Match one"),
      item("episode.139785", "Duplicate match"),
      item("movie-7", "Not an episode"),
    ]),
  ], "sport");

  assertEquals(entries.length, 1);
  assertEquals(entries[0], {
    id: "episode-139785",
    contentId: "episode.139785",
    name: "Match one",
    img: "https://img/1920x1080/cover.jpg",
    slug: "match-one",
    kind: "event",
    sourceUrl: null,
    streamKind: "unknown",
    lastCheckedAt: null,
    lastError: null,
    discoveryScope: "sport",
    releaseDateLabel: "24 Aug",
    liveLabel: "LIVE",
  });
});

Deno.test("parses wrapped Premier League carousel items", () => {
  const entries = parseDiscoveryEntries([
    section("Premier League Live", [{
      id: "recommendation-1",
      content: item("episode-42", "Arsenal v Chelsea"),
    }]),
  ], "premier-league");

  assertEquals(
    entries.map((entry) => ({
      id: entry.id,
      contentId: entry.contentId,
      scope: entry.discoveryScope,
    })),
    [{
      id: "episode-42",
      contentId: "episode.42",
      scope: "premier-league",
    }],
  );
});

Deno.test("fails when the expected live section is missing", () => {
  let message = "";
  try {
    parseDiscoveryEntries([section("Sport Highlights", [])], "sport");
  } catch (error) {
    message = (error as Error).message;
  }
  assert(message.includes("Sport Live"), `unexpected error: ${message}`);
});

Deno.test("refreshes scopes independently and shares same-scope in-flight work", async () => {
  const calls: DiscoveryScope[] = [];
  let releaseSport: (() => void) | undefined;
  const sportGate = new Promise<void>((resolve) => {
    releaseSport = resolve;
  });
  const store = new DiscoveryStore(async (scope) => {
    calls.push(scope);
    if (scope === "sport") await sportGate;
    const name = scope === "sport" ? "Sport Live" : "Premier League Live";
    return [section(name, [item(`episode-${scope === "sport" ? 1 : 2}`)])];
  });

  const sportOne = store.get("sport", true);
  const sportTwo = store.get("sport", true);
  const premier = store.get("premier-league", true);
  assert(
    sportOne === sportTwo,
    "same scope should return the in-flight promise",
  );
  assertEquals((await premier).entries[0].contentId, "episode.2");
  assertEquals(calls, ["sport", "premier-league"]);
  releaseSport?.();
  assertEquals((await sportOne).entries[0].contentId, "episode.1");
});

Deno.test("keeps the last successful snapshot when a forced refresh fails", async () => {
  let fail = false;
  const store = new DiscoveryStore(async () => {
    if (fail) throw new Error("temporary upstream failure");
    return [section("Sport Live", [item("episode-7", "Stored match")])];
  });

  const fresh = await store.get("sport", true);
  fail = true;
  const stale = await store.get("sport", true);

  assertEquals(fresh.freshness, "fresh");
  assertEquals(stale.freshness, "stale");
  assertEquals(stale.entries[0].name, "Stored match");
  assertEquals(stale.fetchedAt, fresh.fetchedAt);
  assertEquals(stale.refreshError, "temporary upstream failure");
});

Deno.test("returns an empty error response when the first refresh fails", async () => {
  const store = new DiscoveryStore(() => Promise.reject(new Error("offline")));
  const result = await store.get("sport", true);
  assertEquals(result.freshness, "empty");
  assertEquals(result.entries, []);
  assertEquals(result.refreshError, "offline");
});
