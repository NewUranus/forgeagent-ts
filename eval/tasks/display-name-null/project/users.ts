export interface User {
  id: number;
  name: string;
  profile?: { nickname?: string | null } | null;
}

/** Nickname when set (trimmed, non-empty), otherwise the account name. */
export function displayName(user: User): string {
  const nickname = user.profile.nickname.trim();
  return nickname || user.name;
}

export function mentionList(users: User[]): string {
  return users.map((user) => `@${displayName(user)}`).join(", ");
}
