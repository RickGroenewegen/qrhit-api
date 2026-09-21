#!/usr/bin/env bash
# Reports invisible or non-ASCII characters in an env file: tabs, carriage
# returns, non-breaking and zero-width spaces, BOMs, smart quotes. Prints the
# line number, the key and the code point only, never the value.
# Usage: ./_scripts/check-env-invisible.sh [path-to-env]   (default: .env)

FILE="${1:-.env}"

if [ ! -f "$FILE" ]; then
  echo "File not found: $FILE"
  exit 2
fi

perl -CSD -ne '
  chomp;
  my $line = $_;
  my ($key) = $line =~ /^\s*#?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/;
  $key //= "(no key)";
  my $commented = $line =~ /^\s*#/ ? " [commented out]" : "";
  while ($line =~ /([^\x20-\x7E])/g) {
    printf "line %d  %s%s  U+%04X at column %d\n", $., $key, $commented, ord($1), pos($line);
    $found = 1;
  }
  if ($line =~ /^[^#]*=.*[ ]$/) {
    printf "line %d  %s  trailing space\n", $., $key;
    $found = 1;
  }
  END {
    print "No invisible or non-ASCII characters found.\n" unless $found;
    exit($found ? 1 : 0);
  }
' "$FILE"
