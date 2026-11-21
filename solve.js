// A faster drop-in for csv-reader 1.0.0.
//
// run(input) returns exactly csv-reader 1.0.0's answer for {text, header}:
// {columns, rows, errors}. Written from the written policy (RULES.txt):
// the text is read once, left to right; a U+FEFF at the very start is
// dropped; a record ends at LF or CRLF and a line left with no characters
// is no record; outside quotes a CR not followed by LF is dropped
// (stray_cr); a field that opens with a quote runs to the next quote that
// is not doubled, "" inside it is one quote and each CRLF or lone CR inside
// it is read as LF; what follows its closing quote up to the next comma or
// line break is appended as it stands (quote_junk, when the field ends); a
// quote that never closes is a literal character and the text after it is
// read again as unquoted (unterminated_quote); a quote inside an unquoted
// field is a literal character; fields stay strings, never trimmed or
// converted; columns is the first record when header is true, else null;
// rows holds the records after it, each padded with "" (short_row, with
// fields: its field count) or cut (long_row, with extra: the cut fields) to
// the first record's width; each error is {code, line, row}, in the order
// met, a record's short_row or long_row when it ends: line the 1-based line
// its record starts on, counting every LF, CRLF and lone CR inside quotes,
// and row its record's index in rows, null for the header.
//
// Speed: the reference walks one character at a time and grows every field
// one character at a time. This reader instead jumps with indexOf to the
// next delimiter, slices each field's text in one step, and takes a whole
// clean line at a time when the line holds no quote and no stray CR (the
// common case). A quoted field's content is likewise sliced in one step
// when it holds no doubled quote and no line break; only content with a
// doubled quote or a line break is walked in pieces. Nothing is read
// twice and no field is ever built a character at a time. One more saving:
// an unquoted field reuses the line end and the line's stray-CR state that
// the record's opening scan already learned, so it pays no fresh scan for
// either; a quoted field that crosses lines clears that state before the
// fields after it read, and an unterminated quote clears it before the
// text is read again as unquoted.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to
// the next.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). Every error of the record carries these.
  let recordLine = 1;
  let recordRow = null;

  // The line the current field is on: the position of its next LF (or the
  // end of the text), and whether that line holds no stray CR, so an
  // unquoted field on it can skip its own CR scan. -1: not known, because
  // a quoted field may have crossed lines or the record just started.
  let lineEnd = -1;
  let lineHasNoCR = false;

  // The last field read, shared by the readers below so no object is built
  // per field: its value, how it ended, and (for an unquoted read) how many
  // characters it kept.
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Learns the line the current field is on: its next LF (or the end of
  // the text) and whether it holds no stray CR. Only called when the line
  // is not already known.
  function refreshLine() {
    const n = text.indexOf('\n', pos);
    lineEnd = n === -1 ? len : n;
    const cEnd =
      n !== -1 && lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13 ? lineEnd - 1 : lineEnd;
    lineHasNoCR = text.slice(pos, cEnd).indexOf('\r') === -1;
  }

  // Appends text[start, end) to `v`, reading each CRLF or lone CR inside
  // it as LF and counting every line break it holds. A segment with no
  // line break at all is one slice; only a segment that holds one is
  // walked in pieces.
  function appendContent(v, start, end) {
    if (start >= end) return v;
    const seg = text.slice(start, end);
    if (seg.indexOf('\n') === -1 && seg.indexOf('\r') === -1) {
      return v === '' ? seg : v + seg;
    }
    let out = v;
    let p = 0;
    const slen = seg.length;
    while (p < slen) {
      const r = seg.indexOf('\r', p);
      const n = seg.indexOf('\n', p);
      let m;
      let isCR;
      if (r !== -1 && (n === -1 || r < n)) {
        m = r;
        isCR = true;
      } else if (n !== -1) {
        m = n;
        isCR = false;
      } else {
        m = -1;
      }
      if (m === -1) {
        const s = seg.slice(p);
        out = out === '' ? s : out + s;
        break;
      }
      if (m > p) {
        const s = seg.slice(p, m);
        out = out === '' ? s : out + s;
      }
      out += '\n';
      line += 1;
      p = isCR && m + 1 < slen && seg.charCodeAt(m + 1) === 10 ? m + 2 : m + 1;
    }
    return out;
  }

  // Reads an unquoted field starting at pos, appending to `value`. A CR
  // not followed by LF is dropped (stray_cr) and the field goes on; a
  // comma, a line break or the end of the text ends it. The field ends at
  // the next comma or at the known end of its line, and a line known to
  // hold no stray CR is taken in one slice. Sets fValue, fEnded and
  // fAdded (the characters kept in this read, not counting the starting
  // value).
  function unquoted(value) {
    let v = value;
    let added = 0;
    if (lineEnd === -1 || pos > lineEnd) refreshLine();
    const c = text.indexOf(',', pos);
    const n = lineEnd;
    let end;
    let isComma;
    if (c !== -1 && c < n) {
      end = c;
      isComma = true;
    } else {
      end = n;
      isComma = false;
    }
    // The field's text, without a CRLF line break's CR at its end.
    let cEnd = end;
    if (!isComma && end !== len && end > pos && text.charCodeAt(end - 1) === 13) cEnd = end - 1;
    if (lineHasNoCR) {
      // The whole line holds no stray CR, so neither does this field.
      if (cEnd > pos) {
        const seg = text.slice(pos, cEnd);
        v = v === '' ? seg : v + seg;
        added += seg.length;
      }
    } else {
      // The stray CRs in the field, if any, are dropped one at a time;
      // the text between them is sliced in one step each.
      let p = pos;
      while (p < cEnd) {
        const seg = text.slice(p, cEnd);
        const r = seg.indexOf('\r');
        if (r === -1) {
          v = v === '' ? seg : v + seg;
          added += seg.length;
          break;
        }
        if (r > 0) {
          const s = seg.slice(0, r);
          v = v === '' ? s : v + s;
          added += r;
        }
        error('stray_cr');
        p = p + r + 1;
      }
    }
    pos = end;
    if (isComma) {
      pos = end + 1;
      fValue = v;
      fEnded = COMMA;
      fAdded = added;
      return;
    }
    if (end === len) {
      fValue = v;
      fEnded = END;
      fAdded = added;
      return;
    }
    pos = end + 1;
    line += 1;
    fValue = v;
    fEnded = LINE_BREAK;
    fAdded = added;
  }

  // Reads a quoted field whose opening quote is at pos. Sets fValue and
  // fEnded.
  function quoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let v = '';
    let start = pos;
    while (true) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        lineEnd = -1;
        lineHasNoCR = false;
        error('unterminated_quote');
        unquoted('"');
        return;
      }
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote is one quote inside the field.
        v = appendContent(v, start, q);
        v += '"';
        pos = q + 2;
        start = pos;
        continue;
      }
      // The closing quote. A field whose content crossed lines leaves
      // the line's end and CR state unknown to the fields after it.
      v = appendContent(v, start, q);
      pos = q + 1;
      if (line !== openLine) {
        lineEnd = -1;
        lineHasNoCR = false;
      }
      if (pos >= len) {
        fValue = v;
        fEnded = END;
        return;
      }
      const ch = text.charCodeAt(pos);
      if (ch === 44) {
        pos += 1;
        fValue = v;
        fEnded = COMMA;
        return;
      }
      if (ch === 10) {
        pos += 1;
        line += 1;
        fValue = v;
        fEnded = LINE_BREAK;
        return;
      }
      if (ch === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        fValue = v;
        fEnded = LINE_BREAK;
        return;
      }
      // What follows the closing quote is appended as it stands, up to
      // the next comma or line break.
      unquoted(v);
      if (fAdded > 0) error('quote_junk');
      return;
    }
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const ch = text.charCodeAt(pos);
      if (ch === 10) {
        pos += 1;
        line += 1;
      } else if (ch === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    let fields;
    let quotedFlag = false;

    // A whole clean line at a time: the line holds no quote and no stray
    // CR, so the record is this line and its fields are the slices between
    // its commas. The line's end and CR state also serve the field-by-field
    // reader when the line is not clean.
    const nl = text.indexOf('\n', pos);
    const le = nl === -1 ? len : nl;
    const contentEnd =
      nl !== -1 && le > pos && text.charCodeAt(le - 1) === 13 ? le - 1 : le;
    const noCR = text.slice(pos, contentEnd).indexOf('\r') === -1;
    const q = text.indexOf('"', pos);
    if ((q === -1 || q >= le) && noCR) {
      fields = [];
      let p = pos;
      while (true) {
        const c = text.indexOf(',', p);
        if (c === -1 || c >= contentEnd) {
          fields.push(text.slice(p, contentEnd));
          break;
        }
        fields.push(text.slice(p, c));
        p = c + 1;
      }
      pos = nl === -1 ? len : nl + 1;
      if (nl !== -1) line += 1;
    }

    if (fields === undefined) {
      // The line holds a quote or a stray CR: read it field by field.
      lineEnd = le;
      lineHasNoCR = noCR;
      fields = [];
      let ended;
      do {
        quotedFlag = text.charCodeAt(pos) === 34;
        if (quotedFlag) {
          quoted();
        } else {
          unquoted('');
        }
        fields.push(fValue);
        ended = fEnded;
      } while (ended === COMMA);
    }

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quotedFlag) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
