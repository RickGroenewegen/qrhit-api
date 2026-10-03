import crypto from 'crypto';
import axios from 'axios';
import { color, white } from 'console-log-colors';
import PrismaInstance from './prisma';
import PushoverClient from './pushover';
import Logger from './logger';

/**
 * Every contact of every company on an EmailOctopus business list in the
 * company's language: NL, EN or DE. The nightly run (Mail.startCron) and the
 * admin's "Sync business lists" button reconcile the three lists with the
 * database: add, update, move between lists, remove.
 *
 * Nobody is ever subscribed again: a PUT without `status` keeps an existing
 * contact's status, a move carries `unsubscribed` to the new list, and an
 * unsubscribed contact who is no longer a company contact stays on the list.
 */

export type BusinessListKey = 'nl' | 'en' | 'de';
export const BUSINESS_LIST_KEYS: BusinessListKey[] = ['nl', 'en', 'de'];

const API_URL = 'https://api.emailoctopus.com';
// Internal people who are linked to a company: never on a business list.
const STAFF_GROUPS = ['admin', 'vibeadmin'];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// A run that would remove more than this share of the lists (and more than
// REMOVAL_GUARD_MIN contacts) removes nothing: a broken query or the wrong
// database must not empty them.
const REMOVAL_GUARD_SHARE = 0.2;
const REMOVAL_GUARD_MIN = 10;

export interface BusinessContactFields {
  FirstName: string;
  LastName: string;
  CompanyName: string;
  Country: string;
}

export interface BusinessContact {
  email: string;
  list: BusinessListKey;
  fields: BusinessContactFields;
}

export interface BusinessCompanyRow {
  id: number;
  name: string;
  locale: string | null;
  countrycode: string | null;
  contact: string | null;
  contactemail: string | null;
  updatedAt: Date;
  User: {
    email: string;
    displayName: string;
    UserGroupUser: { UserGroup: { name: string } }[];
  }[];
}

export interface CurrentContact {
  email: string;
  list: BusinessListKey;
  status: string;
  fields: Record<string, unknown>;
}

export type BusinessSyncAction =
  | { type: 'add'; contact: BusinessContact }
  | { type: 'update'; contact: BusinessContact }
  | {
      type: 'move';
      contact: BusinessContact;
      from: BusinessListKey[];
      status?: 'unsubscribed';
    }
  | { type: 'remove'; email: string; list: BusinessListKey }
  | { type: 'keep'; email: string; list: BusinessListKey };

export interface BusinessSyncResult {
  dryRun: boolean;
  skippedReason?: 'not_configured' | 'already_running';
  wanted: number;
  perList: Record<BusinessListKey, number>;
  added: string[];
  updated: string[];
  moved: string[];
  removed: string[];
  kept: string[];
  unchanged: number;
  skipped: string[];
  errors: string[];
  removalsBlocked: boolean;
}

/** The list for a company's language. NULL is the column default, nl. */
export function businessListFor(locale: string | null): BusinessListKey {
  const value = (locale || '').trim().toLowerCase();
  if (value === '' || value === 'nl') return 'nl';
  if (value === 'de') return 'de';
  return 'en';
}

export function splitName(name: string | null): {
  FirstName: string;
  LastName: string;
} {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  return { FirstName: parts[0] || '', LastName: parts.slice(1).join(' ') };
}

/**
 * The wanted state: each company's contact address and users (staff left
 * out), one entry per lowercased e-mail. When an address belongs to several
 * companies, the latest updated company wins.
 */
export function wantedContacts(companies: BusinessCompanyRow[]): {
  contacts: Map<string, BusinessContact>;
  invalid: string[];
} {
  const contacts = new Map<string, BusinessContact>();
  const invalid = new Set<string>();
  const ordered = [...companies].sort(
    (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
  );

  for (const company of ordered) {
    const people = [
      { email: company.contactemail, name: company.contact },
      ...company.User.filter(
        (user) =>
          !user.UserGroupUser.some((g) => STAFF_GROUPS.includes(g.UserGroup.name))
      ).map((user) => ({ email: user.email, name: user.displayName })),
    ];

    for (const person of people) {
      const email = (person.email || '').trim().toLowerCase();
      if (!email || contacts.has(email)) continue;
      if (!EMAIL_PATTERN.test(email)) {
        invalid.add(email);
        continue;
      }
      contacts.set(email, {
        email,
        list: businessListFor(company.locale),
        fields: {
          ...splitName(person.name),
          CompanyName: company.name.trim(),
          Country: (company.countrycode || '').trim(),
        },
      });
    }
  }

  return { contacts, invalid: [...invalid] };
}

function differs(contact: BusinessContact, current: CurrentContact): boolean {
  return (Object.keys(contact.fields) as (keyof BusinessContactFields)[]).some(
    (key) => String(current.fields[key] ?? '') !== contact.fields[key]
  );
}

// subscribed and pending carry no choice of the contact's; anything else
// (unsubscribed, and whatever EmailOctopus adds) is respected.
function isOptedOut(status: string): boolean {
  return status !== 'subscribed' && status !== 'pending';
}

/** What the run will do, from the wanted state and the lists' contents. */
export function planBusinessSync(
  wanted: Map<string, BusinessContact>,
  current: CurrentContact[]
): { actions: BusinessSyncAction[]; unchanged: number } {
  const byEmail = new Map<string, CurrentContact[]>();
  for (const entry of current) {
    const email = entry.email.trim().toLowerCase();
    byEmail.set(email, [...(byEmail.get(email) || []), entry]);
  }

  const actions: BusinessSyncAction[] = [];
  let unchanged = 0;

  for (const contact of wanted.values()) {
    const entries = byEmail.get(contact.email) || [];
    const here = entries.find((e) => e.list === contact.list);
    const elsewhere = entries.filter((e) => e.list !== contact.list);

    if (elsewhere.length) {
      const optedOut = !here && elsewhere.some((e) => isOptedOut(e.status));
      actions.push({
        type: 'move',
        contact,
        from: elsewhere.map((e) => e.list),
        ...(optedOut ? { status: 'unsubscribed' as const } : {}),
      });
    } else if (here) {
      if (differs(contact, here)) actions.push({ type: 'update', contact });
      else unchanged++;
    } else {
      actions.push({ type: 'add', contact });
    }
  }

  for (const [email, entries] of byEmail) {
    if (wanted.has(email)) continue;
    for (const entry of entries) {
      actions.push({
        type: isOptedOut(entry.status) ? 'keep' : 'remove',
        email,
        list: entry.list,
      });
    }
  }

  return { actions, unchanged };
}

export class BusinessContacts {
  private static instance: BusinessContacts;
  private prisma = PrismaInstance.getInstance();
  private pushover = new PushoverClient();
  private logger = new Logger();
  private running = false;
  // EmailOctopus allows 10 requests a second.
  public writeDelayMs = 150;
  public retryDelayMs = 2000;

  public static getInstance(): BusinessContacts {
    if (!BusinessContacts.instance) {
      BusinessContacts.instance = new BusinessContacts();
    }
    return BusinessContacts.instance;
  }

  public isRunning(): boolean {
    return this.running;
  }

  private listIds(): Record<BusinessListKey, string> | null {
    const ids = {
      nl: process.env['MAIL_OCTOPUS_BUSINESS_LIST_ID_NL'] || '',
      en: process.env['MAIL_OCTOPUS_BUSINESS_LIST_ID_EN'] || '',
      de: process.env['MAIL_OCTOPUS_BUSINESS_LIST_ID_DE'] || '',
    };
    return ids.nl && ids.en && ids.de ? ids : null;
  }

  private headers() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env['MAIL_OCTOPUS_API_KEY']}`,
    };
  }

  private info(text: string, param?: string | number) {
    this.logger.log(
      color.blue.bold(`[${white.bold('businessContacts')}] ${text}`) +
        (param !== undefined ? white.bold(String(param)) : '')
    );
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async loadWanted() {
    const companies = await this.prisma.company.findMany({
      select: {
        id: true,
        name: true,
        locale: true,
        countrycode: true,
        contact: true,
        contactemail: true,
        updatedAt: true,
        User: {
          select: {
            email: true,
            displayName: true,
            UserGroupUser: {
              select: { UserGroup: { select: { name: true } } },
            },
          },
        },
      },
    });
    return wantedContacts(companies);
  }

  private async loadCurrent(
    ids: Record<BusinessListKey, string>
  ): Promise<CurrentContact[]> {
    const current: CurrentContact[] = [];
    for (const list of BUSINESS_LIST_KEYS) {
      let cursor: string | null = null;
      do {
        const params: Record<string, string | number> = { limit: 100 };
        if (cursor) params['starting_after'] = cursor;
        const response: any = await axios.get(
          `${API_URL}/lists/${ids[list]}/contacts`,
          { headers: this.headers(), params }
        );
        for (const c of response.data?.data || []) {
          current.push({
            email: String(c.email_address || ''),
            list,
            status: String(c.status || ''),
            fields: c.fields || {},
          });
        }
        cursor = response.data?.paging?.next?.starting_after || null;
      } while (cursor);
    }
    return current;
  }

  /** A write, paced, with one retry when EmailOctopus says slow down. */
  private async write(request: () => Promise<unknown>): Promise<void> {
    try {
      await request();
    } catch (err: any) {
      if (err.response?.status !== 429) throw err;
      await this.wait(this.retryDelayMs);
      await request();
    } finally {
      await this.wait(this.writeDelayMs);
    }
  }

  private upsert(
    listId: string,
    contact: BusinessContact,
    status?: 'unsubscribed'
  ) {
    return this.write(() =>
      axios.put(
        `${API_URL}/lists/${listId}/contacts`,
        {
          email_address: contact.email,
          fields: contact.fields,
          ...(status ? { status } : {}),
        },
        { headers: this.headers() }
      )
    );
  }

  private delete(listId: string, email: string) {
    const contactId = crypto.createHash('md5').update(email).digest('hex');
    return this.write(() =>
      axios.delete(`${API_URL}/lists/${listId}/contacts/${contactId}`, {
        headers: this.headers(),
      })
    );
  }

  public async sync(
    options: { dryRun?: boolean } = {}
  ): Promise<BusinessSyncResult> {
    const dryRun = !!options.dryRun;
    const result: BusinessSyncResult = {
      dryRun,
      wanted: 0,
      perList: { nl: 0, en: 0, de: 0 },
      added: [],
      updated: [],
      moved: [],
      removed: [],
      kept: [],
      unchanged: 0,
      skipped: [],
      errors: [],
      removalsBlocked: false,
    };

    const ids = this.listIds();
    if (!ids) {
      this.logger.log(
        color.yellow.bold(
          `[${white.bold('businessContacts')}] Skipping business list sync - ${white.bold('MAIL_OCTOPUS_BUSINESS_LIST_ID_NL/EN/DE')} not configured`
        )
      );
      return { ...result, skippedReason: 'not_configured' };
    }
    if (this.running) {
      this.logger.log(
        color.yellow.bold(
          `[${white.bold('businessContacts')}] Business list sync already running`
        )
      );
      return { ...result, skippedReason: 'already_running' };
    }

    this.running = true;
    try {
      this.info(`Starting business list sync${dryRun ? ' (dry run)' : ''}`);

      const { contacts, invalid } = await this.loadWanted();
      const current = await this.loadCurrent(ids);
      const { actions, unchanged } = planBusinessSync(contacts, current);

      result.wanted = contacts.size;
      for (const contact of contacts.values()) result.perList[contact.list]++;
      result.unchanged = unchanged;
      result.skipped = invalid;

      const removals = actions.filter((a) => a.type === 'remove').length;
      result.removalsBlocked =
        removals > REMOVAL_GUARD_MIN &&
        removals > current.length * REMOVAL_GUARD_SHARE;

      for (const action of actions) {
        const email =
          action.type === 'remove' || action.type === 'keep'
            ? action.email
            : action.contact.email;

        if (action.type === 'keep') {
          result.kept.push(email);
          continue;
        }
        if (action.type === 'remove' && result.removalsBlocked) continue;

        const bucket = {
          add: result.added,
          update: result.updated,
          move: result.moved,
          remove: result.removed,
        }[action.type];

        if (dryRun) {
          bucket.push(email);
          continue;
        }

        try {
          if (action.type === 'remove') {
            await this.delete(ids[action.list], email);
          } else if (action.type === 'move') {
            await this.upsert(ids[action.contact.list], action.contact, action.status);
            for (const list of action.from) await this.delete(ids[list], email);
          } else {
            await this.upsert(ids[action.contact.list], action.contact);
          }
          bucket.push(email);
        } catch (err: any) {
          if (err.response?.status === 422) {
            result.skipped.push(email);
            this.logger.log(
              color.yellow.bold(
                `[${white.bold('businessContacts')}] Skipping invalid contact ${white.bold(email)}: ${white.bold(err.response?.data?.detail || 'Unprocessable content')}`
              )
            );
          } else {
            result.errors.push(email);
            this.logger.log(
              color.red.bold(
                `[${white.bold('businessContacts')}] Error syncing ${white.bold(email)}: ${white.bold(err.message)}`
              )
            );
          }
        }
      }

      if (result.removalsBlocked) {
        this.logger.log(
          color.yellow.bold(
            `[${white.bold('businessContacts')}] Not removing ${white.bold(removals)} of ${white.bold(current.length)} contacts: more than ${white.bold(`${REMOVAL_GUARD_SHARE * 100}%`)} of the lists`
          )
        );
        if (!dryRun) {
          await this.pushover.sendMessage(
            {
              title: `${process.env['PRODUCT_NAME']} Business list sync`,
              message: `Not removing ${removals} of ${current.length} business contacts: more than ${REMOVAL_GUARD_SHARE * 100}% of the lists. Check the companies query.`,
              sound: 'falling',
            },
            '127.0.0.1'
          );
        }
      }

      this.logger.log(
        color.green.bold(
          `[${white.bold('businessContacts')}] Business list sync ${dryRun ? 'planned' : 'done'}: ` +
            `${white.bold(result.wanted)} contacts (NL ${white.bold(result.perList.nl)}, EN ${white.bold(result.perList.en)}, DE ${white.bold(result.perList.de)}), ` +
            `added ${white.bold(result.added.length)}, updated ${white.bold(result.updated.length)}, moved ${white.bold(result.moved.length)}, ` +
            `removed ${white.bold(result.removed.length)}, kept ${white.bold(result.kept.length)}, unchanged ${white.bold(result.unchanged)}, ` +
            `skipped ${white.bold(result.skipped.length)}, errors ${white.bold(result.errors.length)}`
        )
      );
      return result;
    } catch (error: any) {
      this.logger.log(
        color.red.bold(
          `[${white.bold('businessContacts')}] Business list sync failed: ${white.bold(error.message)}`
        )
      );
      if (!dryRun) {
        await this.pushover.sendMessage(
          {
            title: `${process.env['PRODUCT_NAME']} Business list sync error`,
            message: `Error during business list sync: ${error.message}`,
            sound: 'falling',
          },
          '127.0.0.1'
        );
      }
      throw error;
    } finally {
      this.running = false;
    }
  }
}

export default BusinessContacts;
