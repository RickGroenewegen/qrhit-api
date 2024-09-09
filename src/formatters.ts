class Formatters {
  constructor() {
    return this;
  }

  getFormatters() {
    const euroFormatter = new Intl.NumberFormat('nl-NL', {
      style: 'currency',
      currency: 'EUR',
    });

    // Format date in Dutch locale
    const dateFormatter = new Intl.DateTimeFormat('nl-NL', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    // Custom formatter to capitalize the first letter of a string
    const firstLetterUppercaseFormatter = (str: string) => {
      if (!str) return str;
      return str.charAt(0).toUpperCase() + str.slice(1);
    };

    return {
      euroFormatter,
      dateFormatter,
      firstLetterUppercaseFormatter,
    };
  }
}

export default Formatters;
