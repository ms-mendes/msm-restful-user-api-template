import { AppError } from "../../middleware/error-handler";
import { IUser, User } from "./user";
import { hash, compare } from "bcryptjs";
import { sendEmail } from "../../helpers/mailer";
import config from "config"
import jwt from "jsonwebtoken"
import crypto from "crypto"
import Roles from "../../types/user-roles";

export const userService = {
    authenticateUser,
    verifyEmail,
    forgotPassword,
    resetPassword,
    create,
    getAll,
    getById,
    getByEmail,
    update,
    _delete
}

async function authenticateUser(requestEmail: string, requestPassword: string, ipAddress: string): Promise<any> {
    const user: IUser | null = await User.findOne( {email: requestEmail} )

    const userNotFound = user == null
    const incorrectPassword = user ? (await compare( requestPassword, user.password! )) == false : true

    if ( userNotFound || incorrectPassword ) {
        throw new AppError("Usuário ou senha inválidos", 400)
    }
    
    // Successful user authentication
    const signedObjectData = {
        userId: user.id,
        userName: user.firstName,
        userRole: user.role
    }

    user.authorizationToken = generateAuthorizationJwtToken( signedObjectData )
    await user.save()
      
    return { ...user.toJSON(), authorizationToken: user.authorizationToken}
}

async function verifyEmail( token: string ) {
    const user: IUser | null = await User.findOne( {verificationToken: token} )

    if ( !user ) throw new AppError( "Token inválido!", 404 )

    user.verifiedAt = new Date()
    user.verificationToken = undefined

    await user.save()
}

async function create( userData: IUser, host: string | undefined = undefined): Promise<IUser> {
    const isFirstUser: boolean = ( await User.countDocuments({}) ) === 0
    const userAlreadyExisits: boolean = await emailAlreadyRegistered( userData.email )

    if ( userAlreadyExisits ) {
        throw new AppError( "Endereço de email já cadastrado", 400 )
    }

    userData.role = isFirstUser ? Roles.admin : Roles.user
    userData.password = await hashUserPassword( userData.password )
    userData.verificationToken = generateRandomTokenString()

    await sendUserVerificationEmail( userData, host )
    
    const newUser: IUser = await User.create( userData )

    return newUser
}

async function getAll(): Promise< IUser[] > {
    const usersList: IUser[] = await User.find()

    return usersList
}

async function getById( id : string ): Promise< IUser > {
    const user: IUser | null = await User.findById( id )

    if ( !user ) {
        throw new AppError( "Usuário não encontrado", 404 )
    }

    return <IUser>user
}

async function getByEmail( email: string ): Promise< Array<IUser> > {
    const user = await User.find(
        {
            email: email
        }
    )

    return user
}

async function update( userId: string, newUserData: IUser ): Promise<IUser> {
    const userToEdit = await User.findById( userId )

    if ( !userToEdit ) throw new AppError("Usuário não encontrado", 404)

    delete newUserData.role

    if ( await emailAlreadyRegistered( newUserData.email ) ) throw new AppError("Email alreay registered", 400)

    Object.assign<IUser, IUser>( <IUser>userToEdit, newUserData )
    await userToEdit.save({timestamps: true})

    return <IUser>userToEdit
}

async function _delete( userId: string ): Promise<void> {
    const user = await User.findById( userId )

    if ( !user ) throw new AppError("User not found", 404)

    await user?.remove()
    return
}

async function forgotPassword( userEmail: string, originHost: string | undefined = undefined ) {
    const user: IUser | null = await User.findOne( { email: userEmail } ) as any

    if ( !user ) {
        throw new AppError('Email not found', 404)
    }

    user.resetPasswordToken = {
        token: generateRandomTokenString(),
        expireAt: new Date(Date.now() + 24*60*60*1000) // 1 days espiration
    }

    await user.save()

    await sendForgotPasswordEmail( user, originHost )

}

async function resetPassword( resetToken: string, password: string ) {
    const user: IUser | null = await User.findOne({ 'resetPasswordToken.token': resetToken })
                                         .where('resetPasswordToken.expiresAt').gt( Date.now() )

    if ( !user ) throw new AppError('Invalid reset token', 400)

    user.password = await hashUserPassword( password )
    user.resetPasswordToken = undefined
    await user.save()
}

// Helper functions
async function emailAlreadyRegistered( email: string ): Promise<boolean> {
    if ( !email ) return false

    const user: IUser[] = await getByEmail( email )

    return user.length > 0
}

async function hashUserPassword( password: string ): Promise<string> {
    return await hash( password, 10 )
}

function generateAuthorizationJwtToken( payload: string | object | Buffer ): string {
    return jwt.sign( payload, config.get<string>('secret'), { expiresIn: '7d' } )
}

function generateRandomTokenString(): string {
    return crypto.randomBytes( 40 ).toString('hex')
}

async function sendUserVerificationEmail( user: IUser, hostAddress: string | undefined = undefined ) {
    let bodyMessage: string

    if ( hostAddress ) {
        const verifyUrl = `http://${ hostAddress }/api/user/verify-user?token=${ user.verificationToken }`
        const lastName = user.lastName ? ` ${user.lastName}` :  ``

        bodyMessage = `<h2>Verificação de cadastro em nossa API</h2>
                       <p>Olá ${ user.firstName }${ lastName }, muito obrigado pela realização de seu cadastro em nosso app.</p>
                       <p>Agora falta apenas fazer a verificação de sua conta</p><br>
                       <p>Por favor, clique no link abaixo para prosseguir com a verificação de seu endereço de email:</p>
                       <code><a href="${ verifyUrl }">${ verifyUrl }</a></code>`
                       
    } else {
        bodyMessage = `<p>Por favor, acesse nosso website e acrescente o link abaixo para prosseguir com a verificação:</p>
                       <pre>Link.................: #NossoWebsite + /api/user/verify-user</pre>
                       <pre>Código de verificação: <code>${ user.verificationToken }</code></pre>`
    }

    await sendEmail(user.email, "Verificação de conta", bodyMessage)
}

async function sendForgotPasswordEmail( user: IUser, hostAddress: string | undefined = undefined ) {
    let bodyMessage: string

    bodyMessage = `<p>Hi ${ user.firstName },</p>
                       <p>There was a request to change your password!</p><br>
                       <p>If you did not make this request then please ignore this email.</p><br>`
    
    if ( hostAddress ) {
        const changePasswordUrl = `http://${ hostAddress }/api/user/reset-password?token=${ user.resetPasswordToken?.token }`

        bodyMessage += `<p>Otherwise, please click the button below to change your password</p>
                        <a href="${ changePasswordUrl }"><button style="width: 130px; height: 40px; padding: 10px 25px; border: 2px solid #000; font-family: 'Lato', sans-serif; font-weight: 500; background: transparent; cursor: pointer;">Change my password</button></a>`
    }
    else {
        bodyMessage += `<p>Otherwise, follow the steps below to change your password</p><br>
                        <pre>Link: #OurWebsite + /api/user/reset-password?token=${ user.resetPasswordToken?.token }</pre>`
    }

    await sendEmail( user.email, `Choose a new password for your [customer portal] account`, bodyMessage )
}