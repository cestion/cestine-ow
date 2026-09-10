import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildMindMapSvg, type MindMapNode, toLeafNodes } from './lib/mindmap-svg';

const data: MindMapNode = {
  name: 'Backend API',
  children: [
    {
      name: 'Story Module',
      children: [
        {
          name: 'Actor IP',
          children: toLeafNodes([
            'mintActorNft',
            'mintActorCollection',
            'prepareActorCollection',
            'listActorCollections',
            'actorCollectionDetail',
            'actorCastDramas',
            'searchActorCollections',
            'ownedActorCollections',
          ]),
        },
        {
          name: 'Create',
          children: toLeafNodes([
            'listAssets1',
            'createSession',
            'createPresign',
            'listDramas',
            'createDrama',
            'takeOffline1',
            'mintDramaNft',
            'submitEditRevision',
            'isExpired',
            'getDrama',
            'deleteDrama',
            'listEpisodes',
            'createEditSession',
            'countOnlineDramas',
            'cancelSession',
          ]),
        },
        {
          name: 'Drama',
          children: toLeafNodes([
            'postReview',
            'playEpisode',
            'toggleFavoriteDrama',
            'toggleLikeEpisode',
            'postComment',
            'toggleLikeComment',
            'completeEpisode',
            'myReview',
            'listPublicDramas',
            'listReviews',
            'getEpisodeDetail',
            'getEpisodeStatistics',
            'listComments',
            'getDramaDetail',
            'listPublicTags',
            'searchPublicDramas',
            'getEpisodeDetailByEpisodeId',
            'deleteComment',
          ]),
        },
        {
          name: 'Internal',
          children: toLeafNodes([
            'reviewDrama',
            'takeOffline',
            'recalculateHeat',
            'reviewDramaEditRevision',
            'listPendingReview',
          ]),
        },
        {
          name: 'Profile',
          children: toLeafNodes(['publishedDramas', 'likedDramas', 'favoriteDramas']),
        },
        {
          name: 'Mock',
          children: toLeafNodes(['listAssets', 'getAsset']),
        },
      ],
    },
    {
      name: 'Mining Module',
      children: [
        {
          name: 'Actor Level Upgrade',
          children: toLeafNodes(['materials']),
        },
        {
          name: 'Mining',
          children: toLeafNodes([
            'restActor',
            'replenishStamina',
            'deployActor',
            'getWeeklyStats',
            'getTotalReward',
            'listRewardDetails',
            'listRestActors',
            'listDeployedActors',
            'listAllActors',
          ]),
        },
        {
          name: 'Mining Health',
          children: toLeafNodes(['health', 'liveness']),
        },
      ],
    },
    {
      name: 'Wallet Module',
      children: [
        {
          name: 'ActorNFT',
          children: toLeafNodes(['upgradeOrder']),
        },
        {
          name: 'Asset',
          children: toLeafNodes(['ledger', 'assets']),
        },
        {
          name: 'Auth',
          children: toLeafNodes(['logout', 'login']),
        },
        {
          name: 'DramaNFT',
          children: toLeafNodes(['positions']),
        },
        {
          name: 'Health',
          children: toLeafNodes(['health', 'liveness']),
        },
        {
          name: 'Income',
          children: toLeafNodes(['usdcIncome']),
        },
        {
          name: 'Internal NFT',
          children: toLeafNodes([
            'listActorNftPositions',
            'listHeldActorCollectionIds',
            'checkActorNftHolding',
          ]),
        },
        {
          name: 'Internal User',
          children: toLeafNodes(['userInfo', 'userInfoByToken']),
        },
        {
          name: 'Internal',
          children: toLeafNodes([
            'debit',
            'credit',
            'platformLedger',
            'platformBalance',
            'orderResult',
            'balance',
          ]),
        },
        {
          name: 'MQ',
          children: toLeafNodes(['send']),
        },
        {
          name: 'User',
          children: toLeafNodes([
            'updateNickname',
            'updateAvatar',
            'userInfo1',
            'otherUserInfo',
            'inviteRecords',
            'inviteInfo',
          ]),
        },
        {
          name: 'Withdraw',
          children: toLeafNodes(['withdraw', 'queryWithdraw']),
        },
      ],
    },
    {
      name: 'Admin Module',
      children: [
        {
          name: 'Default',
          children: toLeafNodes(['getApiAdminV1ConfigsKeysKeys']),
        },
      ],
    },
  ],
};

const outputPath = join(process.cwd(), 'docs', 'api-mindmap.svg');
const svg = buildMindMapSvg(data, 'API Mind Map');

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, svg, 'utf8');
console.log('SVG generated at docs/api-mindmap.svg');




dsadsadsadsa


dsadsadsadsads
