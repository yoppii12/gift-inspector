import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import HelpIcon from '@mui/icons-material/Help';
import {Box, Stack, Typography} from '@mui/material';
import {
  type InspectionItem,
  type InspectionResult,
  type ItemResult,
  REF_WARNING_LABELS,
} from '@gift-inspector/shared';
import type {ReactNode} from 'react';

import {tokens} from '../theme';
import {SectionTitle} from './Layout';

const {color} = tokens;

/**
 * 判定結果の表示（docs/error-handling.md 5.1）。
 * - OK: メイン色のチェック。アクセント色は使わない
 * - NG: アクセント色の「!」と左帯
 * - 判定不能（UNREADABLE）: アクセント色の「?」と左帯。NG とはアイコンと文言で区別する
 * ERROR はこの部品ではなく ErrorPanel で表示する（品質の判定ではないため）。
 */
export function ResultView({
  result,
  photoUrl,
}: {
  result: InspectionResult;
  photoUrl: string | null;
}) {
  const judged = result.items.filter(i => i.result !== 'SKIP');
  const okCount = judged.filter(i => i.result === 'OK').length;
  const attention = judged.length - okCount;

  return (
    <Box>
      {photoUrl && (
        <Box
          component="img"
          src={photoUrl}
          alt="撮影した写真"
          sx={{
            display: 'block',
            width: '100%',
            maxHeight: 280,
            objectFit: 'contain',
            bgcolor: color.main04,
            borderRadius: `${tokens.radius.card}px`,
            mb: 2,
          }}
        />
      )}

      <OverallAlert result={result} />

      {result.refWarnings.length > 0 && (
        <Alert
          accent
          icon={<ErrorIcon sx={{color: color.accent}} />}
          title="参考判定の警告"
          body={
            <Box component="ul" sx={{m: 0, pl: 2.5}}>
              {result.refWarnings.map(w => (
                <li key={w}>{REF_WARNING_LABELS[w]}</li>
              ))}
            </Box>
          }
        />
      )}

      <SectionTitle title="判定内容" aside={`OK ${okCount}件・要確認 ${attention}件`} />
      <Box>
        {result.items.map(item => (
          <ItemRow key={item.key} item={item} />
        ))}
      </Box>

      <SectionTitle title="参考判定" aside="判定には使いません" />
      <ReferenceRows result={result} />
    </Box>
  );
}

function OverallAlert({result}: {result: InspectionResult}) {
  if (result.overall === 'OK') {
    return (
      <Alert
        icon={<CheckCircleIcon sx={{color: color.main}} />}
        title="すべて登録内容と一致しました"
        body="出荷に進めます。"
      />
    );
  }
  if (result.overall === 'UNREADABLE') {
    return (
      <Alert
        accent
        icon={<HelpIcon sx={{color: color.accent}} />}
        title="読み取れませんでした（NG扱い）"
        body="明るい場所で、のし・カード全体が写るように撮り直してください。"
      />
    );
  }
  const ngLabels = result.items.filter(i => i.result === 'NG').map(i => i.label);
  return (
    <Alert
      accent
      icon={<ErrorIcon sx={{color: color.accent}} />}
      title={
        result.ngReason === 'REF_MISMATCH'
          ? '参考判定の警告があるため NG としました'
          : `${ngLabels.join('・')}が登録内容と一致しません`
      }
      body="現物を確認してください。"
    />
  );
}

function Alert({
  icon,
  title,
  body,
  accent,
}: {
  icon: ReactNode;
  title: string;
  body: ReactNode;
  accent?: boolean;
}) {
  return (
    <Box
      role="status"
      sx={{
        bgcolor: color.main04,
        borderRadius: `${tokens.radius.card}px`,
        borderLeft: accent ? `4px solid ${color.accent}` : 'none',
        p: 2,
        mb: 1.5,
      }}
    >
      <Stack direction="row" spacing={1.5} sx={{alignItems: 'flex-start'}}>
        <Box sx={{mt: '1px', display: 'flex'}}>{icon}</Box>
        <Box sx={{minWidth: 0}}>
          <Typography variant="h3" component="p">
            {title}
          </Typography>
          <Typography
            variant="body2"
            component="div"
            sx={{mt: 0.5, color: color.main60, fontWeight: 400}}
          >
            {body}
          </Typography>
        </Box>
      </Stack>
    </Box>
  );
}

const RESULT_TEXT: Record<ItemResult, string> = {
  OK: '一致',
  NG: '不一致',
  UNREADABLE: '読み取れず',
  SKIP: '対象外',
};

function ResultIcon({result}: {result: ItemResult}) {
  const sx = {fontSize: 22};
  switch (result) {
    case 'OK':
      return <CheckCircleIcon sx={{...sx, color: color.main}} />;
    case 'NG':
      return <ErrorIcon sx={{...sx, color: color.accent}} />;
    case 'UNREADABLE':
      return <HelpIcon sx={{...sx, color: color.accent}} />;
    case 'SKIP':
      return (
        <Box
          sx={{width: 22, height: 22, borderRadius: '50%', border: `1.5px solid ${color.main25}`}}
        />
      );
  }
}

/** 1項目: アイコン・項目名・結果と、その下に「登録」「AI読取」を並べる */
function ItemRow({item}: {item: InspectionItem}) {
  const strong = item.result === 'NG' || item.result === 'UNREADABLE';
  return (
    <Box
      sx={{py: 1.5, '& + &': {borderTop: `1px solid ${color.main08}`}}}
      data-item={item.key}
      data-result={item.result}
    >
      <Stack direction="row" spacing={1.25} sx={{alignItems: 'center'}}>
        <ResultIcon result={item.result} />
        <Typography variant="body1" sx={{flex: 1, fontWeight: 600}}>
          {item.label}
        </Typography>
        <Typography
          variant="body2"
          sx={{color: strong ? color.main : color.main60, fontWeight: strong ? 600 : 500}}
        >
          {RESULT_TEXT[item.result]}
        </Typography>
      </Stack>
      {item.result !== 'SKIP' && (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: '56px 1fr',
            columnGap: 1,
            rowGap: 0.5,
            mt: 1,
            pl: '34px',
          }}
        >
          <Compare label="登録" value={item.expected} />
          <Compare label="AI読取" value={item.read} strong={strong} />
        </Box>
      )}
    </Box>
  );
}

function Compare({label, value, strong}: {label: string; value: string | null; strong?: boolean}) {
  return (
    <>
      <Typography variant="caption">{label}</Typography>
      <Typography
        variant="body2"
        sx={{
          wordBreak: 'break-all',
          fontWeight: strong ? 600 : 500,
          color: value === null ? color.main40 : color.main,
        }}
      >
        {value === null || value === '' ? '（読み取れず）' : value}
      </Typography>
    </>
  );
}

function ReferenceRows({result}: {result: InspectionResult}) {
  const r = result.reference;
  const yesNo = (v: boolean | null) => (v === null ? '—' : v ? 'あり' : 'なし');
  const rows = [
    ['のし', yesNo(r.noshiPresent)],
    ['メッセージカード', yesNo(r.cardPresent)],
    ['水引', `${r.mizuhikiRead ?? '—'}（登録: ${r.mizuhikiExpected ?? 'なし'}）`],
  ];
  return (
    <Box sx={{display: 'grid', gridTemplateColumns: '120px 1fr', rowGap: 0.75}}>
      {rows.map(([label, value]) => (
        <Box key={label} sx={{display: 'contents'}}>
          <Typography variant="body2" sx={{color: color.main60, fontWeight: 400}}>
            {label}
          </Typography>
          <Typography variant="body2">{value}</Typography>
        </Box>
      ))}
    </Box>
  );
}
