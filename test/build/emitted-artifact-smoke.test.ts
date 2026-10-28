import { test } from "node:test";
import assert from "node:assert/strict";
import { startPlexFixture } from "./emitted-artifact-smoke.ts";

test("container fixture: representative Plex reads are deterministic", async () => {
  const fixture = await startPlexFixture();
  try {
    const sections = await fetch(`${fixture.baseUrl.replace("host.docker.internal", "127.0.0.1")}/library/sections`);
    assert.deepEqual((await sections.json()).MediaContainer.Directory.map((section: { title: string }) => section.title), ["Movies"]);
    const media = await fetch(`${fixture.baseUrl.replace("host.docker.internal", "127.0.0.1")}/library/sections/1/all`);
    assert.equal((await media.json()).MediaContainer.Metadata[0].title, "Fixture movie");
  } finally {
    await fixture.close();
  }
});
