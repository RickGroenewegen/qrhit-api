/**
 * Create the EmailOctopus business lists that src/businessContacts.ts keeps
 * in sync with the companies: one per language (NL, EN, DE), a LIVE and a
 * DEVELOPMENT copy of each, like the consumer lists. Each list gets the
 * custom fields the sync writes (CompanyName, Country) next to EmailOctopus's
 * own FirstName and LastName.
 *
 * Lists and fields that already exist are reused, so running it again only
 * fills in what is missing. It ends with the .env lines: the LIVE ones go on
 * every production API server, the DEVELOPMENT ones in the local .env.
 *
 *   npx tsx scripts/create-business-octopus-lists.ts          # report only
 *   npx tsx scripts/create-business-octopus-lists.ts --write  # create
 */
import 'dotenv/config';
import axios from 'axios';

const API_URL = 'https://api.emailoctopus.com';
const write = process.argv.includes('--write');
const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${process.env['MAIL_OCTOPUS_API_KEY']}`,
};

const LANGUAGES = ['NL', 'EN', 'DE'];
const ENVIRONMENTS = ['LIVE', 'DEVELOPMENT'];
const FIELDS = [
  { label: 'Company name', tag: 'CompanyName', type: 'text' },
  { label: 'Country', tag: 'Country', type: 'text' },
];

interface OctopusList {
  id: string;
  name: string;
  fields: { tag: string }[];
}

async function allLists(): Promise<OctopusList[]> {
  const lists: OctopusList[] = [];
  let cursor: string | null = null;
  do {
    const params: Record<string, string | number> = { limit: 100 };
    if (cursor) params['starting_after'] = cursor;
    const response: any = await axios.get(`${API_URL}/lists`, { headers, params });
    lists.push(...(response.data?.data || []));
    cursor = response.data?.paging?.next?.starting_after || null;
  } while (cursor);
  return lists;
}

async function main() {
  if (!process.env['MAIL_OCTOPUS_API_KEY']) {
    throw new Error('MAIL_OCTOPUS_API_KEY is not set');
  }

  const existing = await allLists();
  const envLines: Record<string, string[]> = { LIVE: [], DEVELOPMENT: [] };

  for (const environment of ENVIRONMENTS) {
    for (const language of LANGUAGES) {
      const name = `QRSong! business (${language}) (${environment})`;
      let list = existing.find((l) => l.name === name);

      if (list) {
        console.log(`exists   ${name} (${list.id})`);
      } else if (write) {
        const response = await axios.post(`${API_URL}/lists`, { name }, { headers });
        list = { id: response.data.id, name, fields: response.data.fields || [] };
        console.log(`created  ${name} (${list.id})`);
      } else {
        console.log(`missing  ${name}`);
      }

      for (const field of FIELDS) {
        if (list?.fields.some((f) => f.tag === field.tag)) continue;
        if (list && write) {
          await axios.post(`${API_URL}/lists/${list.id}/fields`, field, { headers });
          console.log(`         + field ${field.tag}`);
        } else {
          console.log(`         field ${field.tag} missing`);
        }
      }

      envLines[environment].push(
        `MAIL_OCTOPUS_BUSINESS_LIST_ID_${language}=${list?.id ?? '<not created yet>'}`
      );
    }
  }

  for (const environment of ENVIRONMENTS) {
    console.log(`\n# ${environment}`);
    console.log(envLines[environment].join('\n'));
  }
  if (!write) console.log('\nReport only. Run with --write to create what is missing.');
}

main().catch((error) => {
  console.error(error.response?.data || error.message);
  process.exit(1);
});
