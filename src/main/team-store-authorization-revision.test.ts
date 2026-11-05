import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCauseEffect } from "../backend/effect-boundary";
import { mergeTeamMemberAuthorizationRevision, TeamStore } from "./team-store";

describe("TeamStore member authorization revision merge", () => {
  it("loads team.json records that predate the revision field", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-auth-revision-"));
    try {
      const path = join(root, "team.json");
      const original = new TeamStore(path);
      await runCauseEffect(original.initialize());
      await runCauseEffect(original.configure("Revision test", "owner", "owner-password-test"));
      const invite = await runCauseEffect(original.createInvite("member"));
      const member = await runCauseEffect(
        original.acceptInvite(invite.token, "revision-member", "member-password-test"),
      );

      const reloaded = new TeamStore(path);
      await runCauseEffect(reloaded.initialize());
      expect(reloaded.memberAuthorizationRevision(member.member.id)).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps legacy records at zero until a permission change", () => {
    const legacy = { role: "member", disabled: false };
    expect(mergeTeamMemberAuthorizationRevision(legacy, legacy, legacy, legacy)).toBe(legacy);
    expect(mergeTeamMemberAuthorizationRevision({ ...legacy, role: "admin" }, legacy, legacy, legacy)).toEqual({
      role: "admin",
      disabled: false,
      authorizationRevision: 1,
    });
  });

  it("does not lower a revision from an older external copy", () => {
    const baseline = { role: "member", disabled: false, authorizationRevision: 2 };
    const mine = { ...baseline, authorizationRevision: 7 };
    const olderTheirs = { ...baseline, name: "changed by an older build" };
    const merged = { ...mine, name: olderTheirs.name };
    expect(mergeTeamMemberAuthorizationRevision(merged, baseline, mine, olderTheirs).authorizationRevision).toBe(7);
  });

  it("advances when a merged role change would otherwise reuse a namespace", () => {
    const baseline = { role: "member", disabled: false, authorizationRevision: 4 };
    const mine = { ...baseline };
    const theirs = { ...baseline, role: "admin" };
    const merged = { ...mine, role: theirs.role };
    expect(mergeTeamMemberAuthorizationRevision(merged, baseline, mine, theirs).authorizationRevision).toBe(5);

    const adminBaseline = { role: "admin", disabled: false, authorizationRevision: 4 };
    const adminMine = { ...adminBaseline };
    const restoredMember = { role: "member", disabled: false, authorizationRevision: 4 };
    expect(
      mergeTeamMemberAuthorizationRevision(restoredMember, adminBaseline, adminMine, restoredMember)
        .authorizationRevision,
    ).toBe(5);
  });
});
