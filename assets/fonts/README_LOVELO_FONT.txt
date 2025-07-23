LOVELO FONT REQUIRED FOR TREFFER TEMPLATE
=========================================

The pdf_treffer_printer.ejs template requires the Lovelo font files to be placed in this directory:

Required files:
- Lovelo.otf (OpenType format)
- Lovelo.ttf (TrueType format)

At least one of these formats is required for the custom Treffer template to display correctly.

The font is referenced in the @font-face CSS rule in pdf_treffer_printer.ejs.

If the font files are not present, the template will fall back to Arial.