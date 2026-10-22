#!/usr/bin/env bash
# Assemble the Pulse RCM training video.
# Per section: 2s title card (silent) + demo clip muxed with narration.
set -euo pipefail
TRAIN="$HOME/workspace/portfolio/rcm-dashboard/video-training"
CLIPS="$TRAIN/clips"; AUDIO="$TRAIN/audio"; CARDS="$TRAIN/cards"; SEG="$TRAIN/segments"
mkdir -p "$CARDS" "$SEG"
FONT="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_R="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

declare -A TITLES=(
  ["01-intro"]="Pulse RCM|Full Product Training"
  ["02-login"]="Signing In|Your private workspace"
  ["03-briefing"]="The Daily Briefing|What needs you today"
  ["04-worklist"]="My Work|The smart worklist"
  ["05-claims"]="Claims Management|Your system of record"
  ["06-scrubber"]="Claim Scrubber|Catch rejections first"
  ["07-edi837"]="837P EDI Export|One click to the clearinghouse"
  ["08-era835"]="835 ERA Auto-Posting|Payments post themselves"
  ["09-appeals"]="Denial Appeal Pipeline|Open to won"
  ["10-letters"]="Auto Appeal Letters|One click, payer-ready"
  ["11-authz"]="Prior Authorization Tracking|Nothing lapses"
  ["12-eligibility"]="Eligibility Verification|Stop denials at the front desk"
  ["13-reports"]="Reports Center|Answers for Monday's meeting"
  ["14-playbook"]="Payer Playbook|Your team's shared brain"
  ["15-templates"]="Letter Templates & Audit Log|Your voice, your trail"
  ["16-outro"]="The Full Loop|Verify. Submit. Appeal. Collect."
)

ORDER="01-intro 02-login 03-briefing 04-worklist 05-claims 06-scrubber 07-edi837 08-era835 09-appeals 10-letters 11-authz 12-eligibility 13-reports 14-playbook 15-templates 16-outro"

LISTFILE="$SEG/concat.txt"
> "$LISTFILE"

for sec in $ORDER; do
  IFS='|' read -r title sub <<< "${TITLES[$sec]}"
  echo "--- $sec: $title"

  # 1. title card (2s, 1400x900, silent)
  ffmpeg -y -v error -f lavfi -i "color=c=0x0b1220:s=1400x900:d=2:r=30" \
    -vf "drawtext=fontfile=$FONT:text='PULSE RCM TRAINING':fontsize=28:fontcolor=0x10b981:x=(w-text_w)/2:y=380,\
         drawtext=fontfile=$FONT:text='$title':fontsize=64:fontcolor=white:x=(w-text_w)/2:y=430,\
         drawtext=fontfile=$FONT_R:text='$sub':fontsize=30:fontcolor=0x94a3b8:x=(w-text_w)/2:y=520" \
    -c:v libx264 -pix_fmt yuv420p -r 30 "$CARDS/$sec-card.mp4"
  echo "file '$CARDS/$sec-card.mp4'" >> "$LISTFILE"

  # 2. demo clip + narration (trim/pad video to audio+1.2s, pad audio with silence tail)
  ADUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$AUDIO/$sec.mp3")
  SEG_DUR=$(python3 -c "print(round($ADUR + 1.2, 2))")
  ffmpeg -y -v error -stream_loop 2 -i "$CLIPS/$sec.webm" -i "$AUDIO/$sec.mp3" \
    -t "$SEG_DUR" -map 0:v -map 1:a \
    -c:v libx264 -pix_fmt yuv420p -preset medium -crf 20 -r 30 \
    -af "apad=whole_dur=$SEG_DUR" -c:a aac -b:a 128k -ar 44100 \
    "$SEG/$sec-seg.mp4"
  echo "file '$SEG/$sec-seg.mp4'" >> "$LISTFILE"
done

# 3. concat everything
ffmpeg -y -v error -f concat -safe 0 -i "$LISTFILE" \
  -c:v libx264 -pix_fmt yuv420p -preset medium -crf 20 \
  -c:a aac -b:a 128k -ar 44100 \
  "$TRAIN/pulse-rcm-training.mp4"

DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$TRAIN/pulse-rcm-training.mp4")
SIZE=$(du -h "$TRAIN/pulse-rcm-training.mp4" | cut -f1)
echo "DONE: pulse-rcm-training.mp4 — ${DUR}s, $SIZE"
