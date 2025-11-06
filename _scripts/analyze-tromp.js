const ExcelJS = require('exceljs');

// Read the Excel file
const filePath = '/Users/rick/Library/CloudStorage/Dropbox/QRSong!/tromp.xlsx';
console.log('Reading Excel file:', filePath);

async function analyzeExcel() {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);

    // Get the first worksheet
    const worksheet = workbook.worksheets[0];
    console.log('\nSheet name:', worksheet.name);

    // Print all cells to understand the structure
    console.log('\n=== ALL CELLS (first 30 rows) ===');
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber <= 30) {
        row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
          const cellAddress = cell.address;
          let info = `${cellAddress}: `;

          if (cell.formula) {
            info += `FORMULA: ${cell.formula}`;
          }
          if (cell.value !== undefined && cell.value !== null) {
            if (typeof cell.value === 'object' && cell.value.result !== undefined) {
              info += ` | VALUE: ${cell.value.result}`;
            } else {
              info += ` | VALUE: ${cell.value}`;
            }
          }
          info += ` | TYPE: ${cell.type}`;
          console.log(info);
        });
      }
    });

    // Focus on specific cells
    console.log('\n=== KEY CELLS ===');
    const keyCells = ['A9', 'B13', 'D13', 'B12', 'D12', 'A1', 'B1', 'D1'];
    keyCells.forEach(addr => {
      const cell = worksheet.getCell(addr);
      console.log(`\n${addr}:`);
      console.log('  Value:', cell.value);
      console.log('  Type:', cell.type);
      if (cell.formula) {
        console.log('  Formula:', cell.formula);
      }
      if (cell.text) {
        console.log('  Text:', cell.text);
      }
    });

  } catch (error) {
    console.error('Error reading Excel file:', error.message);
    console.error(error);
  }
}

analyzeExcel();
