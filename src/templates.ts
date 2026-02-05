import * as Handlebars from 'handlebars';
import fs from 'fs/promises';
import path from 'path';
import { format } from 'date-fns';

// Track if partials have been registered
let partialsRegistered = false;

// Register partials
async function registerPartials() {
  if (partialsRegistered) return;

  const partialsDir = `${process.env['APP_ROOT']}/templates/mails/partials`;
  try {
    const files = await fs.readdir(partialsDir);
    for (const file of files) {
      if (file.endsWith('.hbs')) {
        const partialName = path.basename(file, '.hbs');
        const partialContent = await fs.readFile(path.join(partialsDir, file), 'utf-8');
        Handlebars.registerPartial(partialName, partialContent);
      }
    }
    partialsRegistered = true;
  } catch {
    // Partials directory may not exist, that's ok
  }
}

Handlebars.registerHelper('formatDate', function (dateString: string) {
  const date = new Date(dateString);
  return format(date, 'MMMM d, yyyy');
});

Handlebars.registerHelper('formatCurrency', function (currencyString) {
  const formattedString = parseFloat(currencyString)
    .toFixed(2)
    .replace('.', ',');

  return formattedString;
});

Handlebars.registerHelper(
  'formatDecimal',
  function (currencyString: string, decimals: number) {
    const formattedString = parseFloat(currencyString).toFixed(decimals);

    return formattedString;
  }
);

Handlebars.registerHelper('gt', function (a: number, b: number) {
  return a > b;
});

class Templates {
  public async render(templatePath: string, data: any): Promise<string> {
    // Ensure partials are registered before rendering
    await registerPartials();

    const fullPath = `${process.env['APP_ROOT']}/templates/${templatePath}.hbs`;

    // Read the template file using fs/promises
    const templateSource = await fs.readFile(fullPath, 'utf-8');

    const template = Handlebars.compile(templateSource);

    const renderedHTML = template(data);

    return renderedHTML;
  }
}

export default Templates;
