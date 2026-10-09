/* eslint-disable @next/next/no-img-element */
import type { CSSProperties } from "react";

import { Scene3DBlockRenderer } from "./Scene3DBlockRenderer";

import type {
  BulletListBlock,
  CalloutBlock,
  ChartBlock,
  CodeBlock,
  ComparisonBlock,
  DefinitionBlock,
  FigureBlock,
  FormulaBlock,
  HeadingBlock,
  NumberedListBlock,
  ParagraphBlock,
  ProcessBlock,
  QuizAnchorBlock,
  QuoteBlock,
  SlideAsset,
  SlideAssetCollection,
  SlideAssetRenderer,
  SlideAssetUrlResolver,
  SlideBlock,
  SpacerBlock,
  TableBlock,
  TableCellValue
} from "./types";

export type BlockRendererProps = {
  block: SlideBlock;
  assets?: SlideAssetCollection;
  renderAsset?: SlideAssetRenderer;
  resolveAssetUrl?: SlideAssetUrlResolver;
};

const blockSpacingStyle: CSSProperties = {
  minWidth: 0
};

const headingStyle: CSSProperties = {
  margin: 0,
  color: "var(--ink)",
  fontSize: "clamp(30px, 4.2vw, 58px)",
  fontWeight: 860,
  letterSpacing: 0,
  lineHeight: 1.04
};

// Ebene 3 ist die Kicker-/Eyebrow-Zeile ueber dem Folieninhalt.
const kickerHeadingStyle: CSSProperties = {
  margin: 0,
  color: "var(--accent)",
  fontSize: "clamp(13px, 1.15vw, 17px)",
  fontWeight: 760,
  letterSpacing: "0.11em",
  lineHeight: 1.3,
  textTransform: "uppercase"
};

const paragraphStyle: CSSProperties = {
  margin: 0,
  color: "var(--ink)",
  fontSize: "clamp(18px, 2.2vw, 28px)",
  lineHeight: 1.38
};

const listStyle: CSSProperties = {
  display: "grid",
  gap: 12,
  margin: 0,
  paddingInlineStart: 24,
  color: "var(--ink)",
  fontSize: "clamp(18px, 2.1vw, 27px)",
  lineHeight: 1.34
};

const definitionStyle: CSSProperties = {
  display: "grid",
  gap: 8,
  padding: "16px 18px",
  border: "1px solid var(--line)",
  borderRadius: "var(--lb-radius-panel)",
  background: "var(--panel)",
  color: "var(--ink)"
};

const definitionTermStyle: CSSProperties = {
  margin: 0,
  color: "var(--brand-night)",
  fontSize: "clamp(18px, 1.8vw, 24px)",
  fontWeight: 860,
  lineHeight: 1.15
};

const definitionTextStyle: CSSProperties = {
  margin: 0,
  fontSize: "clamp(16px, 1.65vw, 22px)",
  lineHeight: 1.35
};

const definitionExampleStyle: CSSProperties = {
  margin: 0,
  color: "var(--muted)",
  fontSize: "clamp(14px, 1.35vw, 18px)",
  fontWeight: 680,
  lineHeight: 1.35
};

const figureStyle: CSSProperties = {
  display: "grid",
  gap: 10,
  margin: 0,
  minWidth: 0
};

const imageStyle: CSSProperties = {
  display: "block",
  width: "100%",
  maxHeight: "min(62vh, 520px)",
  border: "1px solid var(--line)",
  borderRadius: "var(--lb-radius-panel)",
  background: "var(--panel-soft)",
  objectFit: "contain"
};

const figurePlaceholderStyle: CSSProperties = {
  display: "grid",
  minHeight: 220,
  placeItems: "center",
  padding: 24,
  border: "1px solid var(--line)",
  borderRadius: "var(--lb-radius-panel)",
  background:
    "linear-gradient(135deg, oklch(98% 0.006 230), oklch(91% 0.02 230))",
  color: "var(--muted)",
  fontSize: 15,
  fontWeight: 760,
  textAlign: "center"
};

const figureAssetRendererStyle: CSSProperties = {
  display: "grid",
  minHeight: 220,
  placeItems: "center",
  padding: 10,
  border: "1px solid var(--line)",
  borderRadius: "var(--lb-radius-panel)",
  background: "var(--panel-soft)",
  overflow: "hidden"
};

const captionStyle: CSSProperties = {
  margin: 0,
  color: "var(--muted)",
  fontSize: 13,
  fontWeight: 650,
  lineHeight: 1.35
};

const formulaStyle: CSSProperties = {
  overflowX: "auto",
  margin: 0,
  padding: "18px 20px",
  border: "1px solid var(--line)",
  borderRadius: "var(--lb-radius-panel)",
  background: "oklch(97% 0.011 230)",
  color: "var(--ink)",
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
  fontSize: "clamp(18px, 2.2vw, 30px)",
  lineHeight: 1.35,
  overflowWrap: "anywhere",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word"
};

const tableWrapStyle: CSSProperties = {
  overflowX: "auto",
  border: "1px solid var(--line)",
  borderRadius: "var(--lb-radius-panel)",
  background: "var(--panel)"
};

const tableStyle: CSSProperties = {
  width: "100%",
  minWidth: 0,
  borderCollapse: "collapse",
  color: "var(--ink)",
  fontSize: "clamp(14px, 1.4vw, 18px)",
  lineHeight: 1.35
};

const tableHeaderStyle: CSSProperties = {
  padding: "12px 14px",
  borderBottom: "1px solid var(--line)",
  background: "oklch(94% 0.014 230)",
  fontWeight: 820,
  textAlign: "left"
};

const tableCellStyle: CSSProperties = {
  padding: "11px 14px",
  borderBottom: "1px solid oklch(86% 0.018 230)",
  verticalAlign: "top"
};

const chartStyle: CSSProperties = {
  display: "grid",
  gap: 12,
  minWidth: 0
};

const chartTitleStyle: CSSProperties = {
  margin: 0,
  color: "var(--ink)",
  fontSize: "clamp(17px, 1.7vw, 22px)",
  fontWeight: 840,
  lineHeight: 1.18
};

const chartPlotStyle: CSSProperties = {
  display: "grid",
  alignItems: "end",
  gridTemplateColumns: "repeat(auto-fit, minmax(42px, 1fr))",
  gap: 10,
  minHeight: 190,
  padding: "14px 14px 12px",
  border: "1px solid var(--line)",
  borderRadius: "var(--lb-radius-panel)",
  background:
    "linear-gradient(180deg, transparent 0 24%, oklch(74% 0.022 230 / 0.18) 24% calc(24% + 1px), transparent calc(24% + 1px)), linear-gradient(180deg, transparent 0 49%, oklch(74% 0.022 230 / 0.18) 49% calc(49% + 1px), transparent calc(49% + 1px)), linear-gradient(180deg, transparent 0 74%, oklch(74% 0.022 230 / 0.18) 74% calc(74% + 1px), transparent calc(74% + 1px)), var(--panel)"
};

const chartItemStyle: CSSProperties = {
  display: "grid",
  alignItems: "end",
  gap: 7,
  minWidth: 0,
  height: "100%"
};

const chartBarStyle: CSSProperties = {
  alignSelf: "end",
  minHeight: 8,
  borderRadius: "8px 8px 3px 3px",
  background: "linear-gradient(180deg, var(--lb-origin-blue), var(--accent))",
  boxShadow: "inset 0 0 0 1px oklch(100% 0 0 / 0.26)"
};

const chartLabelStyle: CSSProperties = {
  color: "var(--muted)",
  fontSize: 11,
  fontWeight: 760,
  lineHeight: 1.15,
  textAlign: "center"
};

const processStyle: CSSProperties = {
  display: "grid",
  gap: 12,
  margin: 0,
  padding: 0,
  listStyle: "none"
};

const processItemStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "34px minmax(0, 1fr)",
  gap: 12,
  alignItems: "start"
};

const processIndexStyle: CSSProperties = {
  display: "grid",
  width: 34,
  height: 34,
  placeItems: "center",
  borderRadius: "50%",
  background: "var(--brand-night)",
  color: "var(--slide)",
  fontSize: 13,
  fontWeight: 900
};

const processTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "clamp(16px, 1.55vw, 21px)",
  fontWeight: 830,
  lineHeight: 1.2
};

const processTextStyle: CSSProperties = {
  margin: "4px 0 0",
  color: "var(--muted)",
  fontSize: "clamp(14px, 1.35vw, 18px)",
  lineHeight: 1.35
};

const comparisonStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(230px, 100%), 1fr))",
  gap: 14,
  minWidth: 0
};

const comparisonSideStyle: CSSProperties = {
  display: "grid",
  gap: 9,
  minWidth: 0,
  padding: "15px 17px",
  border: "1px solid var(--line)",
  borderRadius: "var(--lb-radius-panel)",
  background: "var(--panel)"
};

const codeStyle: CSSProperties = {
  overflowX: "auto",
  margin: 0,
  padding: "16px 18px",
  border: "1px solid var(--line)",
  borderRadius: "var(--lb-radius-panel)",
  background: "oklch(18% 0.035 235)",
  color: "oklch(95% 0.012 230)",
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
  fontSize: "clamp(13px, 1.2vw, 16px)",
  lineHeight: 1.45,
  overflowWrap: "anywhere",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word"
};

const quoteStyle: CSSProperties = {
  display: "grid",
  gap: 10,
  margin: 0,
  padding: "18px 20px",
  borderLeft: "5px solid var(--accent)",
  background: "var(--panel)",
  color: "var(--ink)",
  borderRadius: "0 var(--lb-radius-panel) var(--lb-radius-panel) 0"
};

const quizAnchorStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  justifySelf: "start",
  minHeight: 38,
  maxWidth: "100%",
  padding: "0 13px",
  border: "1px solid var(--accent)",
  borderRadius: "var(--lb-radius-pill)",
  background: "var(--accent-soft)",
  color: "var(--ink)",
  fontSize: 13,
  fontWeight: 860,
  lineHeight: 1.2
};

const spacerSizes: Record<SpacerBlock["size"], number> = {
  small: 10,
  medium: 22,
  large: 40
};

const calloutBaseStyle: CSSProperties = {
  display: "grid",
  gap: 6,
  padding: "16px 18px",
  border: "1px solid var(--line)",
  borderLeftWidth: 5,
  borderRadius: "var(--lb-radius-panel)",
  background: "var(--panel)",
  color: "var(--ink)"
};

const calloutTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "clamp(16px, 1.6vw, 21px)",
  fontWeight: 820,
  lineHeight: 1.2
};

const calloutTextStyle: CSSProperties = {
  margin: 0,
  fontSize: "clamp(15px, 1.55vw, 20px)",
  lineHeight: 1.38
};

const calloutToneStyles: Record<NonNullable<CalloutBlock["tone"]>, CSSProperties> = {
  info: {
    borderColor: "var(--lb-kinematic)",
    background: "var(--lb-kinematic-soft)"
  },
  key: {
    borderColor: "var(--accent)",
    background: "var(--accent-soft)"
  },
  tip: {
    borderColor: "var(--green)",
    background: "var(--green-soft)"
  },
  warning: {
    borderColor: "var(--red)",
    background: "var(--red-soft)"
  }
};

const unsupportedBlockStyle: CSSProperties = {
  padding: "14px 16px",
  border: "1px dashed var(--line)",
  borderRadius: "var(--lb-radius-panel)",
  background: "oklch(97% 0.006 230)",
  color: "var(--muted)",
  fontSize: 14,
  fontWeight: 720
};

export function BlockRenderer({ block, assets, renderAsset, resolveAssetUrl }: BlockRendererProps) {
  switch (block.type) {
    case "heading":
      return <HeadingBlockRenderer block={block} />;
    case "paragraph":
      return <ParagraphBlockRenderer block={block} />;
    case "bulletList":
      return <BulletListBlockRenderer block={block} />;
    case "numberedList":
      return <NumberedListBlockRenderer block={block} />;
    case "definition":
      return <DefinitionBlockRenderer block={block} />;
    case "figure":
      return (
        <FigureBlockRenderer
          assets={assets}
          block={block}
          renderAsset={renderAsset}
          resolveAssetUrl={resolveAssetUrl}
        />
      );
    case "formula":
      return <FormulaBlockRenderer block={block} />;
    case "table":
      return <TableBlockRenderer block={block} />;
    case "callout":
      return <CalloutBlockRenderer block={block} />;
    case "chart":
      return <ChartBlockRenderer block={block} />;
    case "process":
      return <ProcessBlockRenderer block={block} />;
    case "comparison":
      return <ComparisonBlockRenderer block={block} />;
    case "code":
      return <CodeBlockRenderer block={block} />;
    case "quote":
      return <QuoteBlockRenderer block={block} />;
    case "quizAnchor":
      return <QuizAnchorBlockRenderer block={block} />;
    case "spacer":
      return <SpacerBlockRenderer block={block} />;
    case "scene3d":
      return <Scene3DBlockRenderer block={block} />;
    default:
      return <UnsupportedBlockRenderer block={block} />;
  }
}

function HeadingBlockRenderer({ block }: { block: HeadingBlock }) {
  const Tag = block.level === 3 ? "h3" : block.level === 2 ? "h2" : "h1";

  return (
    <div data-block-id={block.id} data-block-type={block.type} style={blockSpacingStyle}>
      <Tag style={block.level === 3 ? kickerHeadingStyle : headingStyle}>{block.text}</Tag>
    </div>
  );
}

function ParagraphBlockRenderer({ block }: { block: ParagraphBlock }) {
  return (
    <p
      data-block-id={block.id}
      data-block-type={block.type}
      style={paragraphStyle}
    >
      {block.text}
    </p>
  );
}

function BulletListBlockRenderer({ block }: { block: BulletListBlock }) {
  return (
    <ul
      data-block-id={block.id}
      data-block-type={block.type}
      style={listStyle}
    >
      {block.items.map((item, index) => (
        <BulletListEntry item={item} key={index} />
      ))}
    </ul>
  );
}

function BulletListEntry({ item }: { item: string }) {
  return <li>{item}</li>;
}

function NumberedListBlockRenderer({ block }: { block: NumberedListBlock }) {
  return (
    <ol
      data-block-id={block.id}
      data-block-type={block.type}
      style={listStyle}
    >
      {block.items.map((item, index) => (
        <li key={`${item}-${index}`}>{item}</li>
      ))}
    </ol>
  );
}

function DefinitionBlockRenderer({ block }: { block: DefinitionBlock }) {
  return (
    <section data-block-id={block.id} data-block-type={block.type} style={definitionStyle}>
      <h2 style={definitionTermStyle}>{block.term}</h2>
      <p style={definitionTextStyle}>{block.definition}</p>
      {block.example ? <p style={definitionExampleStyle}>Beispiel: {block.example}</p> : null}
    </section>
  );
}

function FigureBlockRenderer({
  assets,
  block,
  renderAsset,
  resolveAssetUrl
}: {
  assets?: SlideAssetCollection;
  block: FigureBlock;
  renderAsset?: SlideAssetRenderer;
  resolveAssetUrl?: SlideAssetUrlResolver;
}) {
  const asset = resolveAsset(assets, block.assetId);
  const customAsset = asset ? renderAsset?.(asset, block) : undefined;
  const imageUrl = asset ? resolveAssetUrl?.(asset, block) ?? asset.url : undefined;
  const altText = block.altText ?? asset?.altText ?? asset?.description ?? asset?.title ?? block.caption ?? "";
  const label = block.caption ?? asset?.title ?? block.assetId ?? "Figure";

  return (
    <figure
      data-asset-id={block.assetId}
      data-block-id={block.id}
      data-block-type={block.type}
      style={figureStyle}
    >
      {customAsset ? (
        <div aria-label={altText || label} data-asset-renderer style={figureAssetRendererStyle}>
          {customAsset}
        </div>
      ) : imageUrl ? (
        <img
          alt={altText}
          loading="lazy"
          src={imageUrl}
          style={{
            ...imageStyle,
            objectFit: block.fit ?? "contain"
          }}
        />
      ) : (
        <div aria-label={label} role="img" style={figurePlaceholderStyle}>
          {label}
        </div>
      )}
      {block.caption ? <figcaption style={captionStyle}>{block.caption}</figcaption> : null}
    </figure>
  );
}

function FormulaBlockRenderer({ block }: { block: FormulaBlock }) {
  const formula = block.latex ?? block.mathMl ?? "";

  return (
    <figure
      data-block-id={block.id}
      data-block-type={block.type}
      style={figureStyle}
    >
      <pre aria-label={formula} role="math" style={formulaStyle}>
        <code>{formula}</code>
      </pre>
      {block.caption ? <figcaption style={captionStyle}>{block.caption}</figcaption> : null}
    </figure>
  );
}

function TableBlockRenderer({ block }: { block: TableBlock }) {
  return (
    <figure
      data-block-id={block.id}
      data-block-type={block.type}
      style={figureStyle}
    >
      <div style={tableWrapStyle}>
        <table style={tableStyle}>
          {block.caption ? <caption style={captionStyle}>{block.caption}</caption> : null}
          <thead>
            <tr>
              {block.columns.map((column, index) => (
                <th
                  key={columnKey(column, index)}
                  scope="col"
                  style={tableHeaderStyle}
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {block.columns.map((column, columnIndex) => (
                  <td
                    key={columnKey(column, columnIndex)}
                    style={tableCellStyle}
                  >
                    {cellValue(row, column, columnIndex)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

function CalloutBlockRenderer({ block }: { block: CalloutBlock }) {
  const tone = block.tone ?? "info";

  return (
    <aside
      data-block-id={block.id}
      data-block-type={block.type}
      style={{ ...calloutBaseStyle, ...calloutToneStyles[tone] }}
    >
      {block.title ? <strong style={calloutTitleStyle}>{block.title}</strong> : null}
      <p style={calloutTextStyle}>{block.text}</p>
    </aside>
  );
}

function ChartBlockRenderer({ block }: { block: ChartBlock }) {
  const series = normalizeChartData(block.data);

  return (
    <figure data-block-id={block.id} data-block-type={block.type} style={chartStyle}>
      {block.title ? <h2 style={chartTitleStyle}>{block.title}</h2> : null}
      <div aria-label={block.title ?? block.caption ?? `${block.chartType} chart`} style={chartPlotStyle}>
        {series.map((item) => (
          <div key={item.label} style={chartItemStyle}>
            <div
              aria-label={`${item.label}: ${item.value}`}
              style={{
                ...chartBarStyle,
                height: `${Math.max(8, item.ratio * 100)}%`
              }}
            />
            <span style={chartLabelStyle}>{item.label}</span>
          </div>
        ))}
      </div>
      {block.caption ? <figcaption style={captionStyle}>{block.caption}</figcaption> : null}
    </figure>
  );
}

function ProcessBlockRenderer({ block }: { block: ProcessBlock }) {
  return (
    <ol data-block-id={block.id} data-block-type={block.type} style={processStyle}>
      {block.steps.map((step, index) => (
        <li key={step.id ?? `${step.title}-${index}`} style={processItemStyle}>
          <span style={processIndexStyle}>{index + 1}</span>
          <div>
            <h3 style={processTitleStyle}>{step.title}</h3>
            {step.text ? <p style={processTextStyle}>{step.text}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function ComparisonBlockRenderer({ block }: { block: ComparisonBlock }) {
  return (
    <section data-block-id={block.id} data-block-type={block.type} style={comparisonStyle}>
      <ComparisonSide title={block.left.title} body={block.left.body} items={block.left.items} />
      <ComparisonSide title={block.right.title} body={block.right.body} items={block.right.items} />
    </section>
  );
}

function ComparisonSide({ title, body, items }: { title: string; body?: string; items?: string[] }) {
  return (
    <div style={comparisonSideStyle}>
      <h3 style={processTitleStyle}>{title}</h3>
      {body ? <p style={processTextStyle}>{body}</p> : null}
      {items?.length ? (
        <ul style={{ ...listStyle, fontSize: "clamp(14px, 1.35vw, 18px)", gap: 7 }}>
          {items.map((item) => <li key={item}>{item}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

function CodeBlockRenderer({ block }: { block: CodeBlock }) {
  return (
    <figure data-block-id={block.id} data-block-type={block.type} style={figureStyle}>
      <pre style={codeStyle}>
        <code>{block.code}</code>
      </pre>
      {block.caption ? <figcaption style={captionStyle}>{block.language} · {block.caption}</figcaption> : null}
    </figure>
  );
}

function QuoteBlockRenderer({ block }: { block: QuoteBlock }) {
  return (
    <blockquote data-block-id={block.id} data-block-type={block.type} style={quoteStyle}>
      <p style={{ ...paragraphStyle, fontWeight: 760 }}>{block.text}</p>
      {block.attribution ? <footer style={captionStyle}>{block.attribution}</footer> : null}
    </blockquote>
  );
}

function QuizAnchorBlockRenderer({ block }: { block: QuizAnchorBlock }) {
  return (
    <span
      data-block-id={block.id}
      data-block-type={block.type}
      data-quiz-anchor={block.anchorId}
      style={quizAnchorStyle}
    >
      Niveau {block.level}{block.prompt ? ` · ${block.prompt}` : ""}
    </span>
  );
}

function SpacerBlockRenderer({ block }: { block: SpacerBlock }) {
  return (
    <span
      aria-hidden="true"
      data-block-id={block.id}
      data-block-type={block.type}
      style={{ display: "block", height: spacerSizes[block.size] }}
    />
  );
}

function resolveAsset(
  assets: SlideAssetCollection | undefined,
  assetId: string | undefined
): SlideAsset | undefined {
  if (!assets || !assetId) return undefined;
  if (Array.isArray(assets)) return assets.find((asset) => asset.id === assetId);
  return assets[assetId];
}

function columnKey(column: string, index: number) {
  return `${column}-${index}`;
}

function cellValue(row: string[], _column: string, columnIndex: number) {
  const value = row[columnIndex];
  return formatTableCell(value);
}

function formatTableCell(value: TableCellValue | undefined) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function normalizeChartData(data: ChartBlock["data"]) {
  const labels = Array.isArray(data?.labels) ? data.labels.map((item) => String(item)) : [];
  const values = Array.isArray(data?.values) ? data.values.map((item) => Number(item)) : [];
  const pairs = labels
    .map((label, index) => ({ label, value: Number.isFinite(values[index]) ? values[index] : 0 }))
    .filter((item) => item.label.trim().length > 0)
    .slice(0, 8);
  const fallback = [
    { label: "A", value: 1 },
    { label: "B", value: 0.72 },
    { label: "C", value: 0.44 }
  ];
  const raw = pairs.length > 0 ? pairs : fallback;
  const max = Math.max(...raw.map((item) => Math.abs(item.value)), 1);
  return raw.map((item) => ({
    ...item,
    ratio: Math.abs(item.value) / max
  }));
}

function UnsupportedBlockRenderer({ block }: { block: SlideBlock }) {
  return (
    <div data-block-id={block.id} data-block-type={block.type} style={unsupportedBlockStyle}>
      Unsupported slide block: {block.type}
    </div>
  );
}
