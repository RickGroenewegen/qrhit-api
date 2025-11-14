const ExcelJS = require('exceljs');

async function readExcelValues() {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile('/Users/rick/Library/CloudStorage/Dropbox/QRSong!/tromp.xlsx');

    const worksheet = workbook.worksheets[0];

    console.log('\n=== Reading All Key Values from Excel ===\n');

    // Read the pricing constants
    console.log('Pricing Constants:');
    console.log('E4:', worksheet.getCell('E4').value);
    console.log('F4:', worksheet.getCell('F4').value);
    console.log('L4:', worksheet.getCell('L4').value);
    console.log('M4:', worksheet.getCell('M4').value);

    console.log('\nBox pricing tiers:');
    console.log('A4 (qty):', worksheet.getCell('A4').value, '| B4 (price):', worksheet.getCell('B4').value);
    console.log('A5 (qty):', worksheet.getCell('A5').value, '| B5 (price):', worksheet.getCell('B5').value);
    console.log('A6 (qty):', worksheet.getCell('A6').value, '| B6 (price):', worksheet.getCell('B6').value);

    console.log('\nCard pricing tiers:');
    console.log('H4 (qty):', worksheet.getCell('H4').value, '| I4 (price):', worksheet.getCell('I4').value);
    console.log('H5 (qty):', worksheet.getCell('H5').value, '| I5 (price):', worksheet.getCell('I5').value);

    // Check current A9 value
    const currentQty = worksheet.getCell('A9').value;
    console.log('\nCurrent A9 (quantity):', currentQty);

    if (currentQty && currentQty > 0) {
      console.log('\nCurrent calculated values (if A9 has value):');
      console.log('B9 value:', worksheet.getCell('B9').value);
      console.log('B10 value:', worksheet.getCell('B10').value);
      console.log('B12 value:', worksheet.getCell('B12').value);
      console.log('B13 value:', worksheet.getCell('B13').value);
      console.log('D9 value:', worksheet.getCell('D9').value);
      console.log('D10 value:', worksheet.getCell('D10').value);
      console.log('D12 value:', worksheet.getCell('D12').value);
      console.log('D13 value:', worksheet.getCell('D13').value);
    }

    // Show all rows up to row 20
    console.log('\n=== All Content (rows 1-20) ===\n');
    for (let row = 1; row <= 20; row++) {
      const rowData = worksheet.getRow(row);
      let rowStr = `Row ${row}: `;
      for (let col = 1; col <= 8; col++) {
        const cell = rowData.getCell(col);
        if (cell.value !== null && cell.value !== undefined) {
          const colLetter = String.fromCharCode(64 + col);
          rowStr += `${colLetter}${row}=${cell.value} | `;
        }
      }
      if (rowStr.length > `Row ${row}: `.length) {
        console.log(rowStr);
      }
    }

  } catch (error) {
    console.error('Error:', error.message);
  }
}

readExcelValues();
