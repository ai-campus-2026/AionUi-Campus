// ========== 申请清单页：重庆大学奖学金文档（真实 PDF 提取 + 规则补标，2026-09-13） ==========
// 来源：《重庆大学优秀学生综合奖学金评定办法（2022年修订）》（重大校发〔2022〕104号）PDF
// 说明：板/控件字段（board/input_kind/requires_evidence）按队友 annotator 词表规则手工补标，
//       与知识库标注口径一致；本文件为前端只读快照，不写入队友 policy-search 知识库。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const realCQUScholarshipDoc: any = {
  "meta": {
    "doc_id": "重庆大学_2022_001",
    "school": "重庆大学",
    "department": "学生处",
    "year": 2022,
    "category": "scholarship",
    "title": "重庆大学优秀学生综合奖学金评定办法（2022年修订）",
    "source_file": "关于印发《重庆大学优秀学生综合奖学金评定办法（2022年修订）》的通知.pdf",
    "effective_date": "2022-07-17",
    "tags": [
      "奖学金",
      "综合奖学金",
      "本科"
    ]
  },
  "raw_text": "重庆大学文件\n\n重大校发〔2022〕104号\n\n关于印发《重庆大学优秀学生综合奖学金评定办法（2022年修订）》的通知\n\n学校各单位：\n\n《重庆大学优秀学生综合奖学金评定办法（2022年修订）》经2022年第20次校长办公会议审议通过，现印发给你们，请遵照执行。\n\n重庆大学\n2022年7月17日\n\n重庆大学优秀学生综合奖学金评定办法（2022年修订）\n\n第一条 为全面贯彻党和国家教育方针，深入落实立德树人根本任务，激励广大学生踔厉奋发、勇毅前行，根据《普通高等学校学生管理规定》（教育部令第41号）文件精神，结合学校实际，制定本办法。\n\n第二条 本办法适用于我校正式录取且在校注册学习的全日制本科学生。\n\n第三条 优秀学生综合奖学金评定工作遵循“公开、公平、公正”的原则。\n\n第四条 学院负责组织本院优秀学生综合奖学金的评定工作，学生处负责优秀学生综合奖学金的审核、发放和管理。\n\n第五条 优秀学生综合奖学金每学期评定一次，每学期开学后一个月内完成。新生入学后第一学期单独评定新生奖学金，不评定优秀学生综合奖学金。\n\n第六条 获得优秀学生综合奖学金的基本条件：\n（一）坚守信念、热爱祖国，拥护中国共产党的领导，政治立场坚定。自觉践行社会主义核心价值观，大力弘扬爱国主义精神。\n（二）崇德向善、诚实守信，自觉遵守国家法律和校纪校规，具有良好的道德品质和行为习惯。\n（三）理想远大、创先争优，担当时代责任，能够起到示范引领作用。\n（四）刻苦学习、锐意创新，德智体美劳全面发展，评选学期内无补考科目。\n（五）强身健体、拼搏向上，积极锻炼身体。\n（六）热爱劳动、砥砺奋进，积极参加集体活动、劳动实践和志愿服务。\n\n第七条 优秀学生综合奖学金分为甲、乙、丙三个等级，其标准和比例为：\n甲等奖学金每人每次1500元，评定比例不超过学生人数3%；\n乙等奖学金每人每次1000元，评定比例不超过学生人数8%；\n丙等奖学金每人每次500元，评定比例不超过学生人数19%。\n\n第八条 优秀学生综合奖学金评定的依据为学生综合素质测评结果。学校制定学生综合素质测评办法，学院在学校制定的综合素质测评办法基础上，结合本学院人才培养目标和立德树人工作实际制定学生综合素质测评实施细则，组织各年级按班级或专业进行评定。\n\n第九条 优秀学生综合奖学金的一般评审程序如下：\n（一）学生处发布评选通知；\n（二）学院组织评审；\n（三）学院公示评审结果，公示期不少于3个工作日；\n（四）学院上报评审结果；\n（五）学生处复核学院评审结果并公示，公示期不少于3个工作日；\n（六）表彰获奖学生，并发放荣誉证书和奖学金。\n\n第十条 本办法由学校授权学生处负责解释。\n\n第十一条 本办法自印发之日起施行，若其他文件中与本办法不一致的，以本办法为准。原《重庆大学优秀学生综合奖学金实施办法》（重大校〔2012〕409号）同时废止。",
  "requirements": {
    "base": {
      "label": "基础门槛",
      "conditions": [
        {
          "id": "condition_cqu_001",
          "category": "base",
          "item": "学生身份要求",
          "description": "适用于正式录取且在校注册学习的全日制本科学生",
          "type": "hard",
          "quantifiable": false,
          "requirement": "正式录取且在校注册学习的全日制本科学生",
          "operator": "none",
          "value": null,
          "unit": "none",
          "source_quote": "本办法适用于我校正式录取且在校注册学习的全日制本科学生。",
          "source_section": "第二条",
          "board": "base",
          "input_kind": "yes_no",
          "requires_evidence": false
        },
        {
          "id": "condition_cqu_003",
          "category": "base",
          "item": "道德品质与遵纪守法",
          "description": "崇德向善、诚实守信，自觉遵守国家法律和校纪校规，具有良好的道德品质和行为习惯",
          "type": "hard",
          "quantifiable": false,
          "requirement": "诚实守信，自觉遵守国家法律和校纪校规",
          "operator": "none",
          "value": null,
          "unit": "none",
          "source_quote": "（二）崇德向善、诚实守信，自觉遵守国家法律和校纪校规，具有良好的道德品质和行为习惯。",
          "source_section": "第六条（二）",
          "board": "base",
          "input_kind": "yes_no",
          "requires_evidence": false
        }
      ]
    },
    "veto": {
      "label": "一票否决",
      "conditions": [
        {
          "id": "condition_cqu_005",
          "category": "veto",
          "item": "无补考科目",
          "description": "评选学期内所修课程无补考科目",
          "type": "hard",
          "quantifiable": false,
          "requirement": "评选学期内无补考科目",
          "operator": "none",
          "value": null,
          "unit": "none",
          "source_quote": "（四）刻苦学习、锐意创新，德智体美劳全面发展，评选学期内无补考科目。",
          "source_section": "第六条（四）",
          "board": "veto",
          "input_kind": "yes_no",
          "requires_evidence": false
        }
      ]
    },
    "other": {
      "label": "其他须知",
      "conditions": [
        {
          "id": "condition_cqu_002",
          "category": "other",
          "item": "政治方向与思想立场",
          "description": "坚守信念、热爱祖国，拥护中国共产党的领导，政治立场坚定；自觉践行社会主义核心价值观",
          "type": "qualitative",
          "quantifiable": false,
          "requirement": "拥护中国共产党的领导，政治立场坚定",
          "operator": "none",
          "value": null,
          "unit": "none",
          "source_quote": "（一）坚守信念、热爱祖国，拥护中国共产党的领导，政治立场坚定。自觉践行社会主义核心价值观，大力弘扬爱国主义精神。",
          "source_section": "第六条（一）",
          "board": "other",
          "input_kind": "none",
          "requires_evidence": false
        },
        {
          "id": "condition_cqu_004",
          "category": "other",
          "item": "示范引领要求",
          "description": "理想远大、创先争优，担当时代责任，能够起到示范引领作用",
          "type": "qualitative",
          "quantifiable": false,
          "requirement": "能够起到示范引领作用",
          "operator": "none",
          "value": null,
          "unit": "none",
          "source_quote": "（三）理想远大、创先争优，担当时代责任，能够起到示范引领作用。",
          "source_section": "第六条（三）",
          "board": "other",
          "input_kind": "none",
          "requires_evidence": false
        },
        {
          "id": "condition_cqu_006",
          "category": "other",
          "item": "身心健康要求",
          "description": "强身健体、拼搏向上，积极锻炼身体",
          "type": "qualitative",
          "quantifiable": false,
          "requirement": "积极锻炼身体",
          "operator": "none",
          "value": null,
          "unit": "none",
          "source_quote": "（五）强身健体、拼搏向上，积极锻炼身体。",
          "source_section": "第六条（五）",
          "board": "other",
          "input_kind": "none",
          "requires_evidence": false
        },
        {
          "id": "condition_cqu_007",
          "category": "other",
          "item": "劳动与志愿服务",
          "description": "热爱劳动、砥砺奋进，积极参加集体活动、劳动实践和志愿服务",
          "type": "qualitative",
          "quantifiable": false,
          "requirement": "积极参加集体活动、劳动实践和志愿服务",
          "operator": "none",
          "value": null,
          "unit": "none",
          "source_quote": "（六）热爱劳动、砥砺奋进，积极参加集体活动、劳动实践和志愿服务。",
          "source_section": "第六条（六）",
          "board": "other",
          "input_kind": "none",
          "requires_evidence": false
        },
        {
          "id": "condition_cqu_008",
          "category": "other",
          "item": "奖学金等级与比例",
          "description": "甲等每人每次1500元（评定比例不超过3%）；乙等每人每次1000元（不超过8%）；丙等每人每次500元（不超过19%）",
          "type": "info",
          "quantifiable": false,
          "requirement": "甲等1500元/≤3%；乙等1000元/≤8%；丙等500元/≤19%",
          "operator": "none",
          "value": null,
          "unit": "none",
          "source_quote": "甲等奖学金每人每次1500元，评定比例不超过学生人数3%；乙等奖学金每人每次1000元，评定比例不超过学生人数8%；丙等奖学金每人每次500元，评定比例不超过学生人数19%。",
          "source_section": "第七条",
          "board": "other",
          "input_kind": "none",
          "requires_evidence": false
        },
        {
          "id": "condition_cqu_009",
          "category": "other",
          "item": "评定依据",
          "description": "以学生综合素质测评结果作为评定依据",
          "type": "info",
          "quantifiable": false,
          "requirement": "以学生综合素质测评结果为评定依据",
          "operator": "none",
          "value": null,
          "unit": "none",
          "source_quote": "优秀学生综合奖学金评定的依据为学生综合素质测评结果。",
          "source_section": "第八条",
          "board": "other",
          "input_kind": "none",
          "requires_evidence": false
        },
        {
          "id": "condition_cqu_010",
          "category": "other",
          "item": "评审程序",
          "description": "学生处发布通知→学院评审→学院公示≥3个工作日→学院上报→学生处复核公示≥3个工作日→表彰发放",
          "type": "info",
          "quantifiable": false,
          "requirement": "公示期不少于3个工作日",
          "operator": "none",
          "value": null,
          "unit": "none",
          "source_quote": "（三）学院公示评审结果，公示期不少于3个工作日；……（五）学生处复核学院评审结果并公示，公示期不少于3个工作日；",
          "source_section": "第九条",
          "board": "other",
          "input_kind": "none",
          "requires_evidence": false
        },
        {
          "id": "condition_cqu_011",
          "category": "other",
          "item": "评定周期",
          "description": "每学期评定一次；新生入学后第一学期单独评定新生奖学金",
          "type": "info",
          "quantifiable": false,
          "requirement": "每学期评定一次",
          "operator": "none",
          "value": null,
          "unit": "none",
          "source_quote": "优秀学生综合奖学金每学期评定一次，每学期开学后一个月内完成。新生入学后第一学期单独评定新生奖学金，不评定优秀学生综合奖学金。",
          "source_section": "第五条",
          "board": "other",
          "input_kind": "none",
          "requires_evidence": false
        }
      ]
    }
  }
};
