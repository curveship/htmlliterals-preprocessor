import AST from 'htmlliterals-preprocessor/AST';

// pre-compiled regular expressions
var rx = {
    propertyLeftSide   : /\s(\S+)\s*=\s*$/,
    embeddedCodePrefix : /^[+\-!~]*[a-zA-Z_$][a-zA-Z_$0-9]*/, // prefix unary operators + identifier
    embeddedCodeInterim: /^(?:\.[a-zA-Z_$][a-zA-Z_$0-9]+)+/, // property chain, like .bar.blech
    embeddedCodeSuffix : /^\+\+|--/, // suffix unary operators
    directiveName      : /^[a-zA-Z_$][a-zA-Z_$0-9]*(:[^\s:=]*)*/, // like "foo:bar:blech"
    stringEscapedEnd   : /[^\\](\\\\)*\\$/, // ending in odd number of escape slashes = next char of string escaped
    ws                 : /^\s*$/,
    leadingWs          : /^\s+/,
    tagTrailingWs      : /\s+(?=\/?>$)/,
    emptyLines         : /\n\s+(?=\n)/g
};

var parens = {
    "(": ")",
    "[": "]",
    "{": "}"
};

export default function parse(TOKS) {
    var i = 0,
        EOF = TOKS.length === 0,
        TOK = !EOF && TOKS[i],
        LINE = 0,
        COL = 0;

    return codeTopLevel();

    function codeTopLevel() {
        var segments = [],
            text = "";

        while (!EOF) {
            if (IS('<') || IS('<!--')) {
                if (text) segments.push(new AST.CodeText(text));
                text = "";
                segments.push(htmlLiteral());
            } else if (IS('"') || IS("'")) {
                text += quotedString();
            } else if (IS('//')) {
                text += codeComment();
            } else {
                text += TOK, NEXT();
            }
        }

        if (text) segments.push(new AST.CodeText(text));

        return new AST.CodeTopLevel(segments);
    }

    function htmlLiteral() {
        if (NOT('<') && NOT('<!--')) ERR("not at start of html expression");

        var col = COL,
            nodes = [],
            mark,
            wsText;

        while (!EOF) {
            if (IS('<')) {
                nodes.push(htmlElement());
            } else if (IS('<!--')) {
                nodes.push(htmlComment());
            } else if (IS('@')) {
                nodes.push(htmlInsert());
            } else {
                mark = MARK();
                wsText = htmlWhitespaceText();

                if (!EOF && (IS('<') || IS('<!--') || IS('@'))) {
                    nodes.push(wsText);
                } else {
                    ROLLBACK(mark);
                    break;
                }
            }
        }

        return new AST.HtmlLiteral(col, nodes);
    }

    function htmlElement() {
        if (NOT('<')) ERR("not at start of html element");

        var beginTag = "",
            properties = [],
            directives = [],
            content = [],
            endTag = "",
            hasContent = true;

        beginTag += TOK, NEXT();

        // scan for attributes until end of opening tag
        while (!EOF && NOT('>') && NOT('/>')) {
            if (IS('@')) {
                directives.push(directive());
            } else if (IS('=')) {
                beginTag = property(beginTag, properties);
            } else {
                beginTag += TOK, NEXT();
            }
        }

        if (EOF) ERR("unterminated start node");

        hasContent = IS('>');

        beginTag += TOK, NEXT();

        // clean up extra whitespace now that directives have been removed
        beginTag = beginTag.replace(rx.tagTrailingWs, "").replace(rx.emptyLines, "");

        if (hasContent) {
            while (!EOF && NOT('</')) {
                if (IS('<')) {
                    content.push(htmlElement());
                } else if (IS('@')) {
                    content.push(htmlInsert());
                } else if (IS('<!--')) {
                    content.push(htmlComment());
                } else {
                    content.push(htmlText());
                }
            }

            if (EOF) ERR("element missing close tag");

            while (!EOF && NOT('>')) {
                endTag += TOK, NEXT();
            }

            if (EOF) ERR("eof while looking for element close tag");

            endTag += TOK, NEXT();
        }

        return new AST.HtmlElement(beginTag, properties, directives, content, endTag);
    }

    function htmlText() {
        var text = "";

        while (!EOF && NOT('<') && NOT('<!--') && NOT('@') && NOT('</')) {
            text += TOK, NEXT();
        }

        return new AST.HtmlText(text);
    }

    function htmlWhitespaceText() {
        var text = "";

        while (!EOF && WS()) {
            text += TOK, NEXT();
        }

        return new AST.HtmlText(text);
    }

    function htmlComment() {
        if (NOT('<!--')) ERR("not in HTML comment");

        var text = "";

        while (!EOF && NOT('-->')) {
            text += TOK, NEXT();
        }

        if (EOF) ERR("unterminated html comment");

        text += TOK, NEXT();

        return new AST.HtmlComment(text);
    }

    function htmlInsert() {
        if (NOT('@')) ERR("not at start of code insert");

        var col = COL;

        NEXT();

        return new AST.HtmlInsert(col, embeddedCode());
    }

    function property(beginTag, properties) {
        if(NOT('=')) ERR("not at equals sign of a property assignment");

        var match,
            name;

        beginTag += TOK, NEXT();

        if (WS()) beginTag += TOK, NEXT();

        match = rx.propertyLeftSide.exec(beginTag);

        // check if it's an attribute not a property assignment
        if (match && NOT('"') && NOT("'")) {
            beginTag = beginTag.substring(0, beginTag.length - match[0].length);

            name = match[1];

            SPLIT(rx.leadingWs);

            properties.push(new AST.Property(name, embeddedCode()));
        }

        return beginTag;
    }

    function directive() {
        if (NOT('@')) ERR("not at start of directive");

        NEXT();

        var name = SPLIT(rx.directiveName),
            segment,
            segments;

        if (!name) ERR("directive must have name");

        if (IS('(')) {
            segments = [];
            segment = balancedParens(segments, "");
            if (segment) segments.push(segment);

            return new AST.Directive(name, new AST.EmbeddedCode(segments));
        } else {
            if (WS()) NEXT();

            if (NOT('=')) ERR("unrecognized directive - must have form like @foo:bar = ... or @foo( ... )");

            NEXT(), SPLIT(rx.leadingWs);

            name = name.split(":");

            return new AST.AttrStyleDirective(name[0], name.slice(1), embeddedCode());
        }
    }

    function embeddedCode() {
        var segments = [],
            text = "",
            part;

        // consume any initial operators and identifier (!foo)
        if (part = SPLIT(rx.embeddedCodePrefix)) {
            text += part;

            // consume any property chain (.bar.blech)
            if (part = SPLIT(rx.embeddedCodeInterim)) {
                text += part;
            }
        }

        // consume any sets of balanced parentheses
        while (PARENS()) {
            text = balancedParens(segments, text);

            // consume interim property chain (.blech.gorp)
            if (part = SPLIT(rx.embeddedCodeInterim)) {
                text += part;
            }
        }

        // consume any operator suffix (++, --)
        if (part = SPLIT(rx.embeddedCodeSuffix)) {
            text += part;
        }

        if (text) segments.push(new AST.CodeText(text));

        if (segments.length === 0) ERR("not in embedded code");

        return new AST.EmbeddedCode(segments);
    }

    function balancedParens(segments, text) {
        var end = PARENS();

        if (end === undefined) ERR("not in parentheses");

        text += TOK, NEXT();

        while (!EOF && NOT(end)) {
            if (IS("'") || IS('"')) {
                text += quotedString();
            } else if (IS('//')) {
                text += codeComment();
            } else if (IS("<") || IS('<!--')) {
                if (text) segments.push(new AST.CodeText(text));
                text = "";
                segments.push(htmlLiteral());
            } else if (IS('(')) {
                text = balancedParens(segments, text);
            } else {
                text += TOK, NEXT();
            }
        }

        if (EOF) ERR("unterminated parentheses");

        text += TOK, NEXT();

        return text;
    }

    function quotedString() {
        if (NOT("'") && NOT('"')) ERR("not in quoted string");

        var quote,
            text;

        quote = text = TOK, NEXT();

        while (!EOF && (NOT(quote) || rx.stringEscapedEnd.test(text))) {
            text += TOK, NEXT();
        }

        if (EOF) ERR("unterminated string");

        text += TOK, NEXT();

        return text;
    }

    function codeComment() {
        if (NOT("//")) ERR("not in code comment");

        var text = "";

        while (!EOF && NOT('\n')) {
            text += TOK, NEXT();
        }

        // EOF within a code comment is ok, just means that the text ended with a comment
        if (!EOF) text += TOK, NEXT();

        return text;
    }

    // token stream ops
    function NEXT() {
        if (TOK === "\n") LINE++, COL = 0;
        else if (TOK) COL += TOK.length;

        if (++i >= TOKS.length) EOF = true, TOK = null;
        else TOK = TOKS[i];
    }

    function ERR(msg) {
        throw new Error(msg);
    }

    function IS(t) {
        return TOK === t;
    }

    function NOT(t) {
        return TOK !== t;
    }

    function MATCH(rx) {
        return rx.test(TOK);
    }

    function MATCHES(rx) {
        return rx.exec(TOK);
    }

    function WS() {
        return !!MATCH(rx.ws);
    }

    function PARENS() {
        return parens[TOK];
    }

    function SPLIT(rx) {
        var m = MATCHES(rx);
        if (m && (m = m[0])) {
            COL += m.length;
            TOK = TOK.substring(m.length);
            if (TOK === "") NEXT();
            return m;
        } else {
            return null;
        }
    }

    function MARK() {
        return {
            TOK: TOK,
            i:   i,
            EOF: EOF,
            LINE: LINE,
            COL: COL
        };
    }

    function ROLLBACK(mark) {
        TOK = mark.TOK;
        i   = mark.i;
        EOF = mark.EOF;
        LINE = mark.LINE;
        COL = mark.COL;
    }
}