export interface CreatedWorkjetDeviceInvite {
  readonly inviteId: string;
  readonly link: string;
  readonly expiresAt: string;
  readonly displayName: string;
}

export interface WorkjetDeviceInviteControlPort {
  readonly create: (input: {
    readonly businessOsInstanceId: string;
    readonly displayName: string;
    readonly ttlSeconds?: number;
  }) => Promise<CreatedWorkjetDeviceInvite>;
  readonly revoke: (input: { readonly inviteId: string }) => Promise<void>;
}

export class WorkjetDeviceInviteControlUnavailableError extends Error {
  constructor() {
    super("Device invite controls are not available for this environment yet.");
    this.name = "WorkjetDeviceInviteControlUnavailableError";
  }
}

export const unavailableWorkjetDeviceInviteControl: WorkjetDeviceInviteControlPort = {
  async create() {
    throw new WorkjetDeviceInviteControlUnavailableError();
  },
  async revoke() {
    throw new WorkjetDeviceInviteControlUnavailableError();
  },
};
