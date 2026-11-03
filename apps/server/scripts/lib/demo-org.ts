export const DEMO_TEAMS = [
  { id: 'team-platform', name: 'Platform', department: 'Development' },
  { id: 'team-web', name: 'Web', department: 'Development' },
  { id: 'team-support', name: 'Customer Support', department: 'Support' },
];

type Person = {
  gh: { id: number; login: string };
  employee?: { id: string; name: string; email: string; role: 'ADMIN' | 'LEAD' | 'MEMBER'; teamId: string | null };
  /** relative share of PRs authored */
  authorWeight: number;
  reviewer: boolean;
};

export const DEMO_PEOPLE: Person[] = [
  { gh: { id: 2010, login: 'farhan-k' }, employee: { id: 'emp-farhan', name: 'Farhan Kabir', email: 'farhan@example.com', role: 'ADMIN', teamId: null }, authorWeight: 0.3, reviewer: true },
  { gh: { id: 2001, login: 'nadia-i' }, employee: { id: 'emp-nadia', name: 'Nadia Islam', email: 'nadia@example.com', role: 'LEAD', teamId: 'team-platform' }, authorWeight: 1, reviewer: true },
  { gh: { id: 2002, login: 'arif-h' }, employee: { id: 'emp-arif', name: 'Arif Hossain', email: 'arif@example.com', role: 'MEMBER', teamId: 'team-platform' }, authorWeight: 1.6, reviewer: true },
  { gh: { id: 2003, login: 'leo-m' }, employee: { id: 'emp-leo', name: 'Leo Martins', email: 'leo@example.com', role: 'MEMBER', teamId: 'team-platform' }, authorWeight: 1.3, reviewer: true },
  { gh: { id: 2004, login: 'priya-n' }, employee: { id: 'emp-priya', name: 'Priya Nair', email: 'priya@example.com', role: 'MEMBER', teamId: 'team-platform' }, authorWeight: 1.1, reviewer: true },
  { gh: { id: 2005, login: 'sam-o' }, employee: { id: 'emp-sam', name: 'Sam Okafor', email: 'sam@example.com', role: 'LEAD', teamId: 'team-web' }, authorWeight: 0.9, reviewer: true },
  { gh: { id: 2006, login: 'tanvir-a' }, employee: { id: 'emp-tanvir', name: 'Tanvir Ahmed', email: 'tanvir@example.com', role: 'MEMBER', teamId: 'team-web' }, authorWeight: 1.5, reviewer: true },
  { gh: { id: 2007, login: 'mira-c' }, employee: { id: 'emp-mira', name: 'Mira Chen', email: 'mira@example.com', role: 'MEMBER', teamId: 'team-web' }, authorWeight: 1.2, reviewer: true },
  { gh: { id: 2008, login: 'rina-d' }, employee: { id: 'emp-rina', name: 'Rina Das', email: 'rina@example.com', role: 'MEMBER', teamId: 'team-support' }, authorWeight: 0.35, reviewer: false },
  { gh: { id: 2009, login: 'omar-f' }, employee: { id: 'emp-omar', name: 'Omar Faruk', email: 'omar@example.com', role: 'MEMBER', teamId: 'team-support' }, authorWeight: 0.2, reviewer: false },
  // Appears in GitHub but is not linked to an employee yet: shows up in Admin → Identities.
  { gh: { id: 2011, login: 'jo-contractor' }, authorWeight: 0.4, reviewer: false },
];

export const DEMO_BOT = { id: 2099, login: 'dependabot[bot]' };

export const DEMO_REPOS = [
  { id: 9001, full_name: 'acme/api' },
  { id: 9002, full_name: 'acme/web-app' },
  { id: 9003, full_name: 'acme/billing' },
  { id: 9004, full_name: 'acme/mobile' },
];
