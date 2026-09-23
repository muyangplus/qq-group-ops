import type {
  IdentityBinding,
  IdentityBindingKind,
  IdentityBindingRepository,
} from "../../src/db/identityBindingRepository.js";

export class FakeIdentityBindingRepository
  implements IdentityBindingRepository
{
  public readonly bindings: IdentityBinding[] = [];
  public readonly bindCalls: Array<{
    kind: IdentityBindingKind;
    officialId: string;
    externalId: string;
  }> = [];
  public failNextBind = false;

  public async bind(
    kind: IdentityBindingKind,
    officialId: string,
    externalId: string,
  ): Promise<void> {
    if (this.failNextBind) {
      this.failNextBind = false;
      throw new Error("database unavailable");
    }
    this.bindCalls.push({ kind, officialId, externalId });
    for (let index = this.bindings.length - 1; index >= 0; index -= 1) {
      const binding = this.bindings[index]!;
      if (
        binding.kind === kind &&
        (binding.officialId === officialId || binding.externalId === externalId)
      ) {
        this.bindings.splice(index, 1);
      }
    }
    this.bindings.push({ kind, officialId, externalId });
  }

  public async findAll(): Promise<IdentityBinding[]> {
    return this.bindings.map((binding) => ({ ...binding }));
  }
}
